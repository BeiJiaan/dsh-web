/**
 * HTTP routes for dsh-session-archive. Every factory defaults to the original
 * loopback fence; the Host may supply an explicit authenticated-owner gate.
 * Admission always precedes body reads. Mutating routes additionally require
 * POST, and the delete route surfaces the host plan on confirmation mismatch.
 * @module @linxin666/dsh-session-archive/host/routes
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { BatchRequestBody } from '../core/types.ts'
import { BusyError, PlanMismatchError, type ArchiveService } from './janitor.ts'
import { readBoundedJson, writeJson } from './http.ts'
import { loopbackAccessGate, type ArchiveAccessGate } from './access.ts'
import { canonicalSessionId } from './session-files.ts'

export const ARCHIVE_API_PREFIX = '/api/dsh-session-archive'

/** Batch bodies carry id arrays; 4 MiB covers ~50k ids with margin. */
const BODY_MAX_BYTES = 4_000_000

/** A custom gate may retain 401/403; exceptions and invalid results fail closed. */
async function fenced(req: IncomingMessage, res: ServerResponse, gate: ArchiveAccessGate): Promise<boolean> {
  let rejection: 401 | 403 = 403
  try {
    const result = await gate(req)
    if (result === undefined) return true
    if (result === 401) rejection = 401
  } catch {
    // A broken or unavailable admission provider must never expose a route.
  }
  writeJson(res, rejection, {
    ok: false,
    error: rejection === 401 ? 'unauthorized' : gate === loopbackAccessGate ? 'forbidden: loopback-only' : 'forbidden',
  })
  return false
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  try {
    return await readBoundedJson(req, BODY_MAX_BYTES)
  } catch {
    // Empty or invalid bodies read as an empty object; id validation rejects.
    return {}
  }
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 200) continue
    // Harness installs mix bare uuids with `session-<uuid>`; accept both and
    // canonicalize. Path-unsafe strings are rejected outright — ids end up in
    // file names for the projection-cache scrub.
    if (entry.includes('/') || entry.includes('\\') || entry.includes('..')) continue
    out.push(canonicalSessionId(entry))
  }
  return out
}

function batchBody(body: unknown): BatchRequestBody {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  return {
    ids: idList(record.ids),
    ...(typeof record.currentSessionId === 'string' ? { currentSessionId: record.currentSessionId } : {}),
    ...(typeof record.expectedTotal === 'number' && Number.isFinite(record.expectedTotal) ? { expectedTotal: Math.round(record.expectedTotal) } : {}),
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error)
}

/** Defaults to loopback-only; supply a gate explicitly to change admission. */
export function makeInventoryRoute(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/inventory`,
    handler: async (req, res) => {
      if (!await fenced(req, res, gate)) return
      try {
        const inventory = await service.inventory()
        writeJson(res, 200, inventory, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/** Defaults to loopback-only; supply a gate explicitly to change admission. */
export function makePreviewRoute(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/preview`,
    handler: async (req, res) => {
      if (!await fenced(req, res, gate)) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      if (!id.startsWith('session-')) {
        writeJson(res, 400, { ok: false, error: 'invalid session id' })
        return
      }
      try {
        const preview = await service.preview(id)
        writeJson(res, 200, preview, { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 404, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

function batchRoute(service: ArchiveService, path: string, run: (body: BatchRequestBody) => Promise<{ results: unknown; freedBytes: number }>, gate: ArchiveAccessGate): WebRoute {
  return {
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (!await fenced(req, res, gate)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let body: BatchRequestBody
      try {
        body = batchBody(await readBody(req))
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorDetail(error) })
        return
      }
      if (body.ids.length === 0) {
        writeJson(res, 400, { ok: false, error: 'no session ids' })
        return
      }
      if (body.ids.length > 20_000) {
        writeJson(res, 413, { ok: false, error: 'too many session ids' })
        return
      }
      try {
        const response = await run(body)
        writeJson(res, 200, response, { 'cache-control': 'no-store' })
      } catch (error) {
        if (error instanceof BusyError) {
          writeJson(res, 409, { ok: false, error: 'busy: another archive operation is running' })
          return
        }
        if (error instanceof PlanMismatchError) {
          writeJson(res, 409, { error: 'plan-mismatch', plan: error.plan })
          return
        }
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/** Defaults to loopback-only; supply a gate explicitly to change admission. */
export function makeArchiveRoute(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute {
  return batchRoute(service, `${ARCHIVE_API_PREFIX}/archive`, (body) => service.archive(body.ids, 'manual', body.currentSessionId), gate)
}

/** Defaults to loopback-only; supply a gate explicitly to change admission. */
export function makeUnarchiveRoute(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute {
  return batchRoute(service, `${ARCHIVE_API_PREFIX}/unarchive`, (body) => service.unarchive(body.ids), gate)
}

/** Defaults to loopback-only; supply a gate explicitly to change admission. */
export function makeDeleteRoute(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute {
  return batchRoute(service, `${ARCHIVE_API_PREFIX}/delete`, (body) => service.deleteSessions(body.ids, {
    currentSessionId: body.currentSessionId,
    ...(body.expectedTotal !== undefined ? { expectedTotal: body.expectedTotal } : {}),
  }), gate)
}

/** Defaults to loopback-only; supply a gate explicitly to change admission. */
export function makeAutoPreviewRoute(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/auto/preview`,
    handler: async (req, res) => {
      if (!await fenced(req, res, gate)) return
      try {
        writeJson(res, 200, await service.autoPreview(), { 'cache-control': 'no-store' })
      } catch (error) {
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/** Defaults to loopback-only; supply a gate explicitly to change admission. */
export function makeAutoRunRoute(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute {
  return {
    kind: 'exact',
    path: `${ARCHIVE_API_PREFIX}/auto/run`,
    handler: async (req, res) => {
      if (!await fenced(req, res, gate)) return
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      let kind: 'archive' | 'delete'
      let currentSessionId: string | undefined
      try {
        const body = (await readBody(req)) as Record<string, unknown>
        if (body.kind !== 'archive' && body.kind !== 'delete') throw new Error('kind must be archive or delete')
        kind = body.kind
        if (typeof body.currentSessionId === 'string') currentSessionId = body.currentSessionId
      } catch (error) {
        writeJson(res, 400, { ok: false, error: errorDetail(error) })
        return
      }
      try {
        const stats = await service.runAutoCycle(kind, currentSessionId)
        writeJson(res, 200, { ok: true, stats }, { 'cache-control': 'no-store' })
      } catch (error) {
        if (error instanceof BusyError) {
          writeJson(res, 409, { ok: false, error: 'busy: another archive operation is running' })
          return
        }
        writeJson(res, 500, { ok: false, error: errorDetail(error) })
      }
    },
  }
}

/** Apply one policy to all seven endpoints; standalone callers stay local by default. */
export function makeArchiveRoutes(service: ArchiveService, gate: ArchiveAccessGate = loopbackAccessGate): WebRoute[] {
  return [
    makeInventoryRoute(service, gate),
    makePreviewRoute(service, gate),
    makeArchiveRoute(service, gate),
    makeUnarchiveRoute(service, gate),
    makeDeleteRoute(service, gate),
    makeAutoPreviewRoute(service, gate),
    makeAutoRunRoute(service, gate),
  ]
}
