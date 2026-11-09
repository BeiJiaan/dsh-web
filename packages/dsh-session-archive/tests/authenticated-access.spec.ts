// @vitest-environment node
/** Regression boundary: official Connection owns Host/Origin and credentials.
 * BrowserAuth is not a public export of the installed Connection package, so
 * admission uses structural mocks; the route suite also exercises real HTTP.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { makeArchiveAccessGate, loopbackAccessGate, type ArchiveAccessGate } from '../src/host/access.ts'
import { readArchiveConfig, readConfigField, type SessionArchiveConfigFields } from '../src/core/config.ts'
import {
  makeArchiveRoutes, makeInventoryRoute, makePreviewRoute, makeArchiveRoute,
  makeUnarchiveRoute, makeDeleteRoute, makeAutoPreviewRoute, makeAutoRunRoute,
} from '../src/host/routes.ts'
import { ArchiveService, BusyError, PlanMismatchError } from '../src/host/janitor.ts'
import { createFakeHost, fakeContext } from './fixtures.ts'

type Connection = Pick<HostConnectionHandle, 'admit'>
const owner = { peer: { principal: { kind: 'owner' } } }
const remoteHeaders = {
  host: 'archive.example:443', origin: 'https://archive.example',
  authorization: 'Bearer original-token', cookie: 'dsh_session=original-cookie',
  'x-forwarded-for': '198.51.100.42', 'cf-connecting-ip': '198.51.100.42',
  'sec-fetch-site': 'same-origin',
}
function request(headers: IncomingMessage['headers'] = remoteHeaders, address = '198.51.100.42'): IncomingMessage {
  return { headers: { ...headers }, socket: { remoteAddress: address }, method: 'POST', url: '/' } as IncomingMessage
}
function connectionReturning(...values: unknown[]) {
  const value = values.length ? values[0] : owner
  const admit = vi.fn((_req: IncomingMessage) => value)
  return { admit, connection: { admit } as unknown as Connection }
}
function optedIn(value: unknown): SessionArchiveConfigFields {
  return { allowAuthenticatedRemote: value } as SessionArchiveConfigFields
}

describe('authenticated archive access policy', () => {
  it.each([undefined, false, null, 0, 1, '', 'true', 'false', [], {}, new Boolean(true)].map((value) => [value]))(
    'requires literal boolean true, not %j', (value) => {
      const { connection, admit } = connectionReturning()
      const getConnection = vi.fn(() => connection)
      expect(makeArchiveAccessGate(optedIn(value), getConnection)(request())).toBe(403)
      expect(getConnection).not.toHaveBeenCalled()
      expect(admit).not.toHaveBeenCalled()
    },
  )

  it('is off with no config and does not require an optional Connection service', () => {
    const getConnection = vi.fn(() => { throw new Error('optional service is absent') })
    expect(makeArchiveAccessGate(undefined, getConnection)(request())).toBe(403)
    expect(getConnection).not.toHaveBeenCalled()
  })

  it('admits an owner and passes the exact original request, headers, and socket unchanged', () => {
    const req = request()
    const headers = req.headers
    const socket = req.socket
    const before = { ...headers }
    const { connection, admit } = connectionReturning()
    expect(makeArchiveAccessGate(optedIn(true), () => connection)(req)).toBeUndefined()
    expect(admit).toHaveBeenCalledExactlyOnceWith(req)
    expect(admit.mock.calls[0]?.[0]).toBe(req)
    expect(req.headers).toBe(headers)
    expect(req.socket).toBe(socket)
    expect(req.headers).toEqual(before)
  })

  it.each(['agent', 'user', 'guest', 'remote', '', undefined])('rejects a non-owner principal %j', (kind) => {
    const { connection } = connectionReturning({ peer: { principal: { kind } } })
    expect(makeArchiveAccessGate(optedIn(true), () => connection)(request())).toBe(403)
  })

  it.each([401, 403])('preserves official authentication rejection %i', (rejection) => {
    const { connection } = connectionReturning({ rejection })
    expect(makeArchiveAccessGate(optedIn(true), () => connection)(request())).toBe(rejection)
  })

  it.each([null, undefined, false, true, 0, 200, 'owner', {}, { peer: null }, { peer: {} },
    { peer: { principal: null } }, { rejection: undefined }, { rejection: 200 },
    { rejection: 401, peer: { principal: { kind: 'owner' } } },
  ])('fails closed on malformed admission %j', (admission) => {
    const { connection } = connectionReturning(admission)
    // A rejection always takes precedence over even an apparent owner.
    const expected = (admission as { rejection?: number } | null)?.rejection === 401 ? 401 : 403
    expect(makeArchiveAccessGate(optedIn(true), () => connection)(request())).toBe(expected)
  })

  it.each([undefined, null, {}, { admit: null }, { admit: true }])('fails closed for unavailable/incompatible Connection %j', (connection) => {
    expect(makeArchiveAccessGate(optedIn(true), () => connection as Connection)(request())).toBe(403)
  })

  it('fails closed if lookup, admit, or a volatile field getter throws', () => {
    expect(makeArchiveAccessGate(optedIn(true), () => { throw new Error('lookup') })(request())).toBe(403)
    expect(makeArchiveAccessGate(optedIn(true), () => ({ admit() { throw new Error('admit') } }))(request())).toBe(403)
    const getter = { get() { throw new Error('config unavailable') } }
    expect(makeArchiveAccessGate(optedIn(getter), () => undefined)(request())).toBe(403)
  })

  it('reads volatile toggles and the current Connection on every request without remounting', () => {
    let enabled: unknown = false
    const field = { get: vi.fn(() => enabled) }
    const first = connectionReturning()
    const second = connectionReturning({ rejection: 401 })
    let current: Connection | undefined = first.connection
    const getConnection = vi.fn(() => current)
    const gate = makeArchiveAccessGate(optedIn(field), getConnection)
    const req = request()
    expect(gate(req)).toBe(403)
    enabled = true
    expect(gate(req)).toBeUndefined()
    current = second.connection
    expect(gate(req)).toBe(401)
    current = undefined
    expect(gate(req)).toBe(403)
    current = first.connection
    expect(gate(req)).toBeUndefined()
    enabled = false
    expect(gate(req)).toBe(403)
    enabled = 'true'
    expect(gate(req)).toBe(403)
    expect(field.get).toHaveBeenCalledTimes(7)
    expect(getConnection).toHaveBeenCalledTimes(4)
    expect(first.admit).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['127.0.0.1', '127.0.0.1:8123'], ['127.42.1.9', 'localhost:8123'],
    ['::1', '[::1]:8123'], ['::ffff:127.0.0.1', 'localhost:8123'],
  ])('keeps local socket %s / Host %s independent of config and Connection', (address, host) => {
    const getConnection = vi.fn(() => { throw new Error('not needed locally') })
    const req = request({ host, origin: `http://${host}` }, address)
    const config = optedIn({ get() { throw new Error('not needed locally') } })
    expect(loopbackAccessGate(req)).toBeUndefined()
    expect(makeArchiveAccessGate(config, getConnection)(req)).toBeUndefined()
    expect(getConnection).not.toHaveBeenCalled()
  })

  it.each([
    { host: 'evil.example' }, { host: 'localhost', origin: 'https://evil.example' },
    { host: 'localhost', origin: 'not a URL' }, { host: 'localhost', 'sec-fetch-site': 'cross-site' },
    { host: 'localhost', 'x-forwarded-for': '127.0.0.1' },
    { host: 'localhost', 'cf-connecting-ip': '127.0.0.1' }, {},
  ])('retains the original local fence for %j', (headers) => {
    const req = request(headers, '127.0.0.1')
    expect(loopbackAccessGate(req)).toBe(403)
    expect(makeArchiveAccessGate(undefined, () => undefined)(req)).toBe(403)
  })

  it('never treats spoofed forwarding headers or loopback Host as proof of local origin', () => {
    const req = request({ host: 'localhost', 'x-forwarded-for': '127.0.0.1' })
    const { connection, admit } = connectionReturning({ rejection: 401 })
    expect(makeArchiveAccessGate(optedIn(true), () => connection)(req)).toBe(401)
    expect(admit).toHaveBeenCalledExactlyOnceWith(req)
  })
})

describe('authenticated access config reads', () => {
  it('leaves absent settings absent rather than opting into remote access', () => {
    expect(readArchiveConfig().allowAuthenticatedRemote).toBeUndefined()
    expect(readConfigField(undefined)).toBeUndefined()
    expect(readArchiveConfig({ allowAuthenticatedRemote: false }).allowAuthenticatedRemote).toBe(false)
    expect(readArchiveConfig({ allowAuthenticatedRemote: true }).allowAuthenticatedRemote).toBe(true)
  })

  it('unwraps the current volatile value instead of snapshotting the setting', () => {
    let value = false
    const config = { allowAuthenticatedRemote: { get: vi.fn(() => value) } }
    expect(readArchiveConfig(config).allowAuthenticatedRemote).toBe(false)
    value = true
    expect(readArchiveConfig(config).allowAuthenticatedRemote).toBe(true)
    value = false
    expect(readArchiveConfig(config).allowAuthenticatedRemote).toBe(false)
    expect(config.allowAuthenticatedRemote.get).toHaveBeenCalledTimes(3)
  })
})

const factories = [
  ['inventory', makeInventoryRoute], ['preview', makePreviewRoute], ['archive', makeArchiveRoute],
  ['unarchive', makeUnarchiveRoute], ['delete', makeDeleteRoute],
  ['auto/preview', makeAutoPreviewRoute], ['auto/run', makeAutoRunRoute],
] as const
function spyService() {
  return {
    inventory: vi.fn(async () => ({ rows: [] })), preview: vi.fn(async () => ({ messages: [] })),
    archive: vi.fn(async () => ({ results: [], freedBytes: 0 })),
    unarchive: vi.fn(async () => ({ results: [], freedBytes: 0 })),
    deleteSessions: vi.fn(async () => ({ results: [], freedBytes: 0 })),
    autoPreview: vi.fn(async () => ({ archive: [], delete: [] })),
    runAutoCycle: vi.fn(async () => ({ archived: 0 })),
  }
}
function responseDouble() {
  return { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
}
function noServiceCalls(service: ReturnType<typeof spyService>) {
  for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
}

describe.each(factories)('%s standalone factory admission', (_name, factory) => {
  it.each([401, 403])('rejects %i before any service call or request body read', async (status) => {
    const service = spyService()
    const req = request()
    req.url = '/?id=session-a'
    const read = vi.fn(() => { throw new Error('body must not be touched') })
    Object.defineProperty(req, Symbol.asyncIterator, { get: read })
    const res = responseDouble()
    const gate = vi.fn(() => status) as ArchiveAccessGate
    const route = factory(service as unknown as ArchiveService, gate)
    await route.handler(req, res)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(vi.mocked(gate).mock.calls[0]?.[0]).toBe(req)
    expect(res.writeHead).toHaveBeenCalledWith(status, expect.any(Object))
    expect(JSON.parse(vi.mocked(res.end).mock.calls[0]![0] as string)).toEqual({ ok: false, error: status === 401 ? 'unauthorized' : 'forbidden' })
    expect(read).not.toHaveBeenCalled()
    noServiceCalls(service)
  })

  it('waits for asynchronous admission before touching service or body', async () => {
    const service = spyService()
    let settle!: (status: 403) => void
    const gate: ArchiveAccessGate = () => new Promise((resolve) => { settle = resolve })
    const req = request()
    const read = vi.fn(() => { throw new Error('body must not be touched') })
    Object.defineProperty(req, Symbol.asyncIterator, { get: read })
    const res = responseDouble()
    const pending = factory(service as unknown as ArchiveService, gate).handler(req, res)
    noServiceCalls(service)
    expect(read).not.toHaveBeenCalled()
    expect(res.writeHead).not.toHaveBeenCalled()
    settle(403)
    await pending
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    expect(read).not.toHaveBeenCalled()
    noServiceCalls(service)
  })

  it.each(['throw', 'reject', null, false, true, 200, 'allow'])('fails closed for a broken custom gate %j', async (value) => {
    const service = spyService()
    const gate = (() => {
      if (value === 'throw') throw new Error('gate failed')
      if (value === 'reject') return Promise.reject(new Error('gate rejected'))
      return value
    }) as ArchiveAccessGate
    const res = responseDouble()
    await factory(service as unknown as ArchiveService, gate).handler(request(), res)
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    noServiceCalls(service)
  })

  it('defaults to the local fence if no custom gate is supplied', async () => {
    const service = spyService()
    const res = responseDouble()
    await factory(service as unknown as ArchiveService).handler(request(), res)
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object))
    noServiceCalls(service)
  })
})

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})
async function serve(routes: WebRoute[]): Promise<string> {
  const server = createServer((req, res) => {
    const route = routes.find((candidate) => candidate.path === new URL(req.url ?? '/', 'http://localhost').pathname)
    if (!route) { res.writeHead(404).end(); return }
    void Promise.resolve(route.handler(req, res)).catch(() => { res.writeHead(500).end() })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
async function http(url: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = remoteHeaders) {
  return new Promise<{ status: number; body: any; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const req = httpRequest(new URL(`/api/dsh-session-archive/${path}`, url), { method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text), headers: res.headers }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}

describe('authenticated archive HTTP routes', () => {
  it('shares the gate across exactly seven routes and serves owner calls', async () => {
    const service = spyService()
    const { connection, admit } = connectionReturning()
    const routes = makeArchiveRoutes(service as unknown as ArchiveService, makeArchiveAccessGate(optedIn(true), () => connection))
    expect(routes.map((route) => route.path)).toEqual(factories.map(([name]) => `/api/dsh-session-archive/${name}`))
    const url = await serve(routes)
    for (const [name] of factories) {
      const mutating = ['archive', 'unarchive', 'delete', 'auto/run'].includes(name)
      const result = await http(url, name === 'preview' ? 'preview?id=session-a' : name,
        mutating ? 'POST' : 'GET', name === 'auto/run' ? { kind: 'archive' } : mutating ? { ids: ['session-a'] } : undefined)
      expect(result.status, name).toBe(200)
      expect(result.headers['cache-control']).toBe('no-store')
    }
    expect(admit).toHaveBeenCalledTimes(7)
    for (const method of Object.values(service)) expect(method).toHaveBeenCalledTimes(1)
    for (const [req] of admit.mock.calls as unknown as [IncomingMessage][]) expect(req.headers).toMatchObject(remoteHeaders)
  })

  it('revokes an already mounted HTTP route immediately when volatile config or live Connection changes', async () => {
    let enabled = false
    let admission: unknown = owner
    const admit = vi.fn(() => admission)
    let current: Connection | undefined = { admit } as unknown as Connection
    const service = spyService()
    const gate = makeArchiveAccessGate(optedIn({ get: () => enabled }), () => current)
    const url = await serve(makeArchiveRoutes(service as unknown as ArchiveService, gate))
    expect((await http(url, 'inventory')).status).toBe(403)
    enabled = true
    expect((await http(url, 'inventory')).status).toBe(200)
    enabled = false
    expect((await http(url, 'inventory')).status).toBe(403)
    enabled = true
    admission = { rejection: 401 }
    expect((await http(url, 'inventory')).status).toBe(401)
    admission = { peer: { principal: { kind: 'agent' } } }
    expect((await http(url, 'inventory')).status).toBe(403)
    admission = owner
    current = undefined
    expect((await http(url, 'inventory')).status).toBe(403)
    current = { admit } as unknown as Connection
    expect((await http(url, 'inventory')).status).toBe(200)
    expect(service.inventory).toHaveBeenCalledTimes(2)
  })

  it.each(['archive', 'unarchive', 'delete', 'auto/run'])('%s retains POST and body validation after owner admission', async (path) => {
    const service = spyService()
    const { connection } = connectionReturning()
    const url = await serve(makeArchiveRoutes(service as unknown as ArchiveService, makeArchiveAccessGate(optedIn(true), () => connection)))
    expect((await http(url, path)).status).toBe(405)
    expect((await http(url, path, 'PUT', { ids: ['session-a'], kind: 'archive' })).status).toBe(405)
    expect((await http(url, path, 'POST', 'not-json')).status).toBe(400)
    expect((await http(url, path, 'POST', {})).status).toBe(400)
    if (path !== 'auto/run') {
      for (const ids of [[], ['../etc/passwd'], ['a\\b'], ['..'], [12, null, '']]) {
        expect((await http(url, path, 'POST', { ids })).status).toBe(400)
      }
      expect((await http(url, path, 'POST', { ids: Array.from({ length: 20_001 }, () => 'session-a') })).status).toBe(413)
    } else {
      expect((await http(url, path, 'POST', { kind: 'destroy' })).status).toBe(400)
    }
    noServiceCalls(service)
  })

  it.each([
    ['archive', makeArchiveRoute], ['unarchive', makeUnarchiveRoute],
    ['delete', makeDeleteRoute], ['auto/run', makeAutoRunRoute],
  ] as const)('%s retains the bounded body reader after authentication', async (_path, factory) => {
    const service = spyService()
    const req = request()
    const iterate = vi.fn(async function* () {
      yield Buffer.from('{"ids":["session-a"],"kind":"delete","padding":"')
      yield Buffer.alloc(4_000_001, 0x61)
      yield Buffer.from('"}')
    })
    Object.defineProperty(req, Symbol.asyncIterator, { value: iterate })
    const res = responseDouble()
    const gate: ArchiveAccessGate = async () => undefined
    await factory(service as unknown as ArchiveService, gate).handler(req, res)
    expect(iterate).toHaveBeenCalledTimes(1)
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    noServiceCalls(service)
  })

  it('retains canonical ids, current-session exclusion input and delete confirmation forwarding', async () => {
    const service = spyService()
    const { connection } = connectionReturning()
    const url = await serve(makeArchiveRoutes(service as unknown as ArchiveService, makeArchiveAccessGate(optedIn(true), () => connection)))
    const bare = '84777561-8adb-452d-a3ac-b25c7e72d36e'
    expect((await http(url, 'delete', 'POST', { ids: [bare], currentSessionId: 'session-current', expectedTotal: 2 })).status).toBe(200)
    expect(service.deleteSessions).toHaveBeenCalledExactlyOnceWith([`session-${bare}`], { currentSessionId: 'session-current', expectedTotal: 2 })
    expect((await http(url, 'archive', 'POST', { ids: ['session-a'], currentSessionId: 'session-current' })).status).toBe(200)
    expect(service.archive).toHaveBeenCalledExactlyOnceWith(['session-a'], 'manual', 'session-current')
    expect((await http(url, 'auto/run', 'POST', { kind: 'delete', currentSessionId: 'session-current' })).status).toBe(200)
    expect(service.runAutoCycle).toHaveBeenCalledExactlyOnceWith('delete', 'session-current')
  })

  it('retains 409 busy and plan-mismatch results after successful authentication', async () => {
    const service = spyService()
    const plan = { direct: ['session-a'], descendants: ['session-b'], skipped: [], targets: ['session-a', 'session-b'], totalBytes: 0 }
    service.deleteSessions.mockRejectedValueOnce(new PlanMismatchError(plan))
    service.archive.mockRejectedValueOnce(new BusyError())
    service.runAutoCycle.mockRejectedValueOnce(new BusyError())
    const { connection } = connectionReturning()
    const url = await serve(makeArchiveRoutes(service as unknown as ArchiveService, makeArchiveAccessGate(optedIn(true), () => connection)))
    const mismatch = await http(url, 'delete', 'POST', { ids: ['session-a'], expectedTotal: 1 })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body).toEqual({ error: 'plan-mismatch', plan })
    expect((await http(url, 'archive', 'POST', { ids: ['session-a'] })).status).toBe(409)
    expect((await http(url, 'auto/run', 'POST', { kind: 'delete' })).status).toBe(409)
  })

  it('does not delete any real service targets when authenticated confirmation mismatches', async () => {
    const host = createFakeHost({
      feedItems: [{ sessionId: 'session-parent', updatedAt: 1 }, { sessionId: 'session-child', parentSessionId: 'session-parent', updatedAt: 2 }],
      persistedIds: ['session-parent', 'session-child'],
      archivedSessionIds: ['session-parent', 'session-child'],
      dirs: ['session-parent', 'session-child'],
    })
    const service = new ArchiveService(fakeContext(host) as never, { dshHome: host.home })
    const remove = vi.spyOn(service, 'deleteSessions')
    const { connection } = connectionReturning()
    const url = await serve(makeArchiveRoutes(service, makeArchiveAccessGate(optedIn(true), () => connection)))
    const result = await http(url, 'delete', 'POST', { ids: ['session-parent'], expectedTotal: 1 })
    expect(result.status).toBe(409)
    expect(result.body.error).toBe('plan-mismatch')
    expect(result.body.plan.targets.sort()).toEqual(['session-child', 'session-parent'])
    expect(host.registry.state.archivedSessionIds.sort()).toEqual(['session-child', 'session-parent'])
    expect(host.persistedIds.sort()).toEqual(['session-child', 'session-parent'])
    expect(existsSync(join(host.home, 'sessions', '--Users-demo--', 'parent', 'session.jsonl.zstd'))).toBe(true)
    expect(existsSync(join(host.home, 'sessions', '--Users-demo--', 'child', 'session.jsonl.zstd'))).toBe(true)
    expect(remove).toHaveBeenCalledTimes(1)
  })
})
