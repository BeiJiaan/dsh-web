/** Owner-authenticated, default-off pairing. Never changes the local token route. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PairingService } from '../core/pairing.ts'
import { WS_PATH } from '../core/protocol.ts'

export const REMOTE_PAIR_INFO_PATH = '/remote-bridge/pair/remote-info'
export const REMOTE_PAIR_TOKEN_PATH = '/remote-bridge/pair/remote-token'
const MAX_BODY_BYTES = 1024

export interface RemotePairConfig {
  remotePairingEnabled: boolean
  trustedPairingOrigins: string[]
}

/** Require the exact canonical HTTPS origin, not a URL we can silently repair. */
export function isCanonicalPairingOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('*')) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname !== '' && url.username === ''
      && url.password === '' && url.origin === value
  } catch {
    return false
  }
}

/** One malformed field disables the entire feature; never retain a partial allowlist. */
export function resolveRemotePairConfig(raw: unknown): RemotePairConfig {
  const disabled = (): RemotePairConfig => ({ remotePairingEnabled: false, trustedPairingOrigins: [] })
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return disabled()
    const fields = raw as Record<string, unknown>
    const flag = fields.remotePairingEnabled
    const origins = fields.trustedPairingOrigins
    if (flag !== undefined && typeof flag !== 'boolean') return disabled()
    if (origins !== undefined && (!Array.isArray(origins) || !Array.from(origins).every(isCanonicalPairingOrigin))) return disabled()
    return {
      remotePairingEnabled: flag === true,
      trustedPairingOrigins: origins === undefined ? [] : [...new Set(origins as string[])],
    }
  } catch {
    return disabled()
  }
}

/** Structural SDK seam: official admit is synchronous; unknown outcomes fail closed. */
export interface RemotePairConnection {
  admit(req: IncomingMessage): unknown
}

export interface RemotePairDeps {
  pairing: Pick<PairingService, 'issueToken' | 'consumeToken'>
  config: () => unknown
  getConnection: () => RemotePairConnection | undefined
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ownerRejection(deps: RemotePairDeps, req: IncomingMessage): 401 | 403 | undefined {
  try {
    const connection = deps.getConnection()
    if (typeof connection?.admit !== 'function') return 403
    const admission = connection.admit(req)
    if (!object(admission)) return 403
    // An incompatible async implementation must not admit or leak an unhandled rejection.
    if (typeof admission.then === 'function') {
      void Promise.resolve(admission).catch(() => undefined)
      return 403
    }
    if ('rejection' in admission) {
      return admission.rejection === 401 ? 401 : 403
    }
    return object(admission.peer) && object(admission.peer.principal)
      && admission.peer.principal.kind === 'owner' ? undefined : 403
  } catch {
    return 403
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(text)
}

function configNow(deps: RemotePairDeps): RemotePairConfig {
  try { return resolveRemotePairConfig(deps.config()) } catch { return resolveRemotePairConfig(undefined) }
}

/** Forwarding headers are deliberately irrelevant: only original Host/Origin count. */
function sameOrigin(req: IncomingMessage, requireOrigin: boolean): boolean {
  const unique = new Set<string>()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const key = req.rawHeaders[i]?.toLowerCase()
    if (key !== 'host' && key !== 'origin' && key !== 'sec-fetch-site' && key !== 'content-type') continue
    if (unique.has(key)) return false
    unique.add(key)
  }
  const host = req.headers.host
  if (typeof host !== 'string' || !isCanonicalPairingOrigin('https://' + host)) return false
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (origin === undefined) return !requireOrigin
  return isCanonicalPairingOrigin(origin) && origin === 'https://' + host
}

/** Bound bytes during streaming, including chunked bodies; stop retaining data at the limit. */
function readBody(req: IncomingMessage): Promise<{ status: number; text?: string }> {
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    return Promise.resolve({ status: 413 })
  }
  return new Promise((resolve) => {
    let bytes = 0
    const chunks: Buffer[] = []
    let settled = false
    const finish = (status: number, text?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', data)
      req.off('end', end)
      req.off('aborted', aborted)
      // Keep the one-shot error listener: an aborted upload can emit its error
      // after 'aborted', including after we already answered a size/timeout denial.
      resolve({ status, ...(text === undefined ? {} : { text }) })
    }
    const data = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > MAX_BODY_BYTES) {
        req.pause()
        finish(413)
      } else chunks.push(buffer)
    }
    const end = (): void => { finish(200, Buffer.concat(chunks).toString('utf8')) }
    const aborted = (): void => { finish(400) }
    const timer = setTimeout(() => { req.pause(); finish(408) }, 10_000)
    timer.unref()
    req.on('data', data)
    req.once('end', end)
    req.once('aborted', aborted)
    req.once('error', aborted)
    if (req.aborted || req.destroyed) finish(400)
  })
}

export function makeRemotePairRoutes(deps: RemotePairDeps): WebRoute[] {
  // Refresh retires only this remote surface's previous ticket. Independent
  // machine-local tickets and already-paired devices remain untouched.
  let previousRemoteToken: string | undefined
  const route = (path: string, method: 'GET' | 'POST'): WebRoute => ({
    kind: 'exact', path,
    handler: async (req, res): Promise<void> => {
      const denial = ownerRejection(deps, req)
      if (denial !== undefined) { writeJson(res, denial, { error: 'forbidden' }); return }
      const config = configNow(deps)
      if (!config.remotePairingEnabled) {
        writeJson(res, 403, { enabled: false, trustedOrigins: [] })
        return
      }
      if (req.method !== method) {
        res.setHeader('allow', method)
        writeJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      if (!sameOrigin(req, method === 'POST')) { writeJson(res, 403, { error: 'cross-origin' }); return }
      if (method === 'GET') {
        writeJson(res, 200, { enabled: true, trustedOrigins: config.trustedPairingOrigins })
        return
      }
      const contentType = req.headers['content-type']
      if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        writeJson(res, 415, { error: 'json-required' }); return
      }
      const body = await readBody(req)
      if (body.status !== 200) {
        // Do not drain an unended upload indefinitely after its byte/deadline
        // budget was exceeded. Flush the small denial, then close this socket.
        res.setHeader('connection', 'close')
        res.once('finish', () => { req.destroy() })
        writeJson(res, body.status, { error: 'invalid-body' })
        return
      }
      let payload: unknown
      try { payload = JSON.parse(body.text ?? '') } catch { writeJson(res, 400, { error: 'invalid-json' }); return }
      if (!object(payload) || !isCanonicalPairingOrigin(payload.origin)) {
        writeJson(res, 400, { error: 'invalid-origin' }); return
      }
      // Re-read after upload: disabling or revoking an origin takes effect before minting.
      const live = configNow(deps)
      if (!live.remotePairingEnabled) { writeJson(res, 403, { enabled: false, trustedOrigins: [] }); return }
      if (!live.trustedPairingOrigins.includes(payload.origin)) {
        writeJson(res, 403, { error: 'untrusted-origin' }); return
      }
      try {
        const ticket = deps.pairing.issueToken()
        if (previousRemoteToken !== undefined && previousRemoteToken !== ticket.value) deps.pairing.consumeToken(previousRemoteToken)
        previousRemoteToken = ticket.value
        const url = 'wss://' + new URL(payload.origin).host + WS_PATH + '?token=' + encodeURIComponent(ticket.value)
        writeJson(res, 200, {
          token: ticket.value, expiresAt: ticket.expiresAt, url, pairingUrl: url,
          origin: payload.origin, originSource: 'configured',
        })
      } catch { writeJson(res, 503, { error: 'pairing-unavailable' }) }
    },
  })
  return [route(REMOTE_PAIR_INFO_PATH, 'GET'), route(REMOTE_PAIR_TOKEN_PATH, 'POST')]
}
