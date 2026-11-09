import { createServer, request, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isUsageAllowed, makeUsageAccessGate } from '../src/host/access.ts'
import { makeUsageDayRoute, makeUsageOverviewRoute, makeUsageRefreshRoute } from '../src/host/routes.ts'
import type { UsageService } from '../src/host/usage-service.ts'

type Gate = (req: IncomingMessage) => 401 | 403 | undefined
type Route = ReturnType<typeof makeUsageOverviewRoute>
const owner = () => ({ peer: { principal: { kind: 'owner' } } })
const asContext = (value: object) => value as Context
const localRequest = (headers: IncomingMessage['headers'] = {}) => ({
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: 'localhost:3000', ...headers },
}) as IncomingMessage
const remoteRequest = (headers: IncomingMessage['headers'] = {}) => ({
  socket: { remoteAddress: '203.0.113.7' },
  headers: { host: 'usage.example.test', ...headers },
}) as IncomingMessage

function connectionContext(admit = vi.fn((_req: IncomingMessage): unknown => owner())) {
  const connection = { admit }
  const get = vi.fn((name: string) => name === 'connection' ? connection : undefined)
  return { ctx: asContext({ get }), get, admit }
}

function usageService() {
  const overviewValue = { ok: true, providers: [], marker: 'overview' }
  const dayValue = { date: '2026-11-09', marker: 'day' }
  const overview = vi.fn(() => overviewValue)
  const day = vi.fn((_date: string) => dayValue)
  const refresh = vi.fn(async () => {})
  return { service: { overview, day, refresh } as unknown as UsageService, overview, day, refresh, overviewValue, dayValue }
}

const servers = new Set<Server>()
afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
  servers.clear()
})

async function serve(route: Route) {
  // The harness deliberately does not turn thrown handler errors into HTTP 500:
  // production routes must handle service failures themselves.
  const failures: unknown[] = []
  const server = createServer((req, res) => {
    Promise.resolve().then(() => route.handler(req, res)).catch(error => {
      failures.push(error)
      res.writeHead(599)
      res.end(JSON.stringify({ error: 'uncaught route failure' }))
    })
  })
  servers.add(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    failures,
    send(path = route.path, method = 'GET', headers: Record<string, string> = {}) {
      return new Promise<{ status: number; headers: IncomingMessage['headers']; body: unknown }>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
          const chunks: Buffer[] = []
          res.on('data', chunk => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode!, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString()) })
            } catch (error) { reject(error) }
          })
        })
        req.on('error', reject)
        req.end()
      })
    },
  }
}

const factories = [
  ['overview', makeUsageOverviewRoute],
  ['day', makeUsageDayRoute],
  ['refresh', makeUsageRefreshRoute],
] as const

describe('makeUsageAccessGate', () => {
  it('keeps the existing local and live paired policy when opt-in is off', () => {
    let paired = true
    const isPairedDevice = vi.fn(() => paired)
    const admit = vi.fn(() => owner())
    const ctx = asContext({ get: (name: string) => name === 'remoteWebUiPairing' ? { isPairedDevice } : { admit } })
    const gate = makeUsageAccessGate(ctx, () => false)
    expect(isUsageAllowed(ctx, localRequest())).toBe(true)
    expect(gate(localRequest())).toBeUndefined()
    const req = remoteRequest({ cookie: 'paired-device=live' })
    expect(isUsageAllowed(ctx, req)).toBe(true)
    expect(gate(req)).toBeUndefined()
    paired = false
    expect(isUsageAllowed(ctx, req)).toBe(false)
    expect(gate(req)).toBe(403)
    expect(isPairedDevice).toHaveBeenLastCalledWith(req)
    expect(admit).not.toHaveBeenCalled()
  })

  it.each([false, undefined, null, 1, 'true', {}])('requires strict true opt-in, not %j', setting => {
    const { ctx, admit } = connectionContext()
    const gate = makeUsageAccessGate(ctx, () => setting as boolean)
    expect(gate(remoteRequest({ authorization: 'Bearer valid' }))).toBe(403)
    expect(admit).not.toHaveBeenCalled()
  })

  it('retains loopback bypass even with opt-in enabled', () => {
    const { ctx, admit } = connectionContext()
    expect(makeUsageAccessGate(ctx, () => true)(localRequest())).toBeUndefined()
    expect(admit).not.toHaveBeenCalled()
  })

  it('uses official admission synchronously and passes the original request and headers unchanged', () => {
    const { ctx, get, admit } = connectionContext()
    const headers = Object.freeze({ host: 'usage.example.test', authorization: 'Bearer actual-token', cookie: 'session=signed', origin: 'https://usage.example.test', 'x-forwarded-for': '203.0.113.7', 'cf-connecting-ip': '203.0.113.7' })
    const req = remoteRequest()
    req.headers = headers
    const before = { ...headers }
    expect(makeUsageAccessGate(ctx, () => true)(req)).toBeUndefined()
    expect(get.mock.calls.some(([name]) => name === 'connection')).toBe(true)
    expect(admit).toHaveBeenCalledExactlyOnceWith(req)
    expect(req.headers).toBe(headers)
    expect(req.headers).toEqual(before)
  })

  it.each([401, 403] as const)('preserves official rejection %i without trusting credentials itself', rejection => {
    const { ctx, admit } = connectionContext(vi.fn(() => ({ rejection })))
    const req = remoteRequest({ authorization: 'Bearer wrong', cookie: 'session=wrong' })
    expect(makeUsageAccessGate(ctx, () => true)(req)).toBe(rejection)
    expect(admit).toHaveBeenCalledExactlyOnceWith(req)
  })

  it.each([
    { peer: { principal: { kind: 'guest' } } },
    { peer: { principal: { kind: 'agent' } } },
    { peer: {} }, {}, undefined, null, true,
    { rejection: 200 },
  ])('fails closed for non-owner or malformed admission %j', admission => {
    const { ctx } = connectionContext(vi.fn(() => admission))
    expect(makeUsageAccessGate(ctx, () => true)(remoteRequest())).toBe(403)
  })

  it('fails closed when connection lookup throws or admission throws', () => {
    const lookupFailure = asContext({ get: () => { throw new Error('not injected') } })
    expect(makeUsageAccessGate(lookupFailure, () => true)(remoteRequest())).toBe(403)
    const { ctx } = connectionContext(vi.fn(() => { throw new Error('admission unavailable') }))
    expect(makeUsageAccessGate(ctx, () => true)(remoteRequest())).toBe(403)
  })

  it.each([{}, { get: () => undefined }, { get: () => ({}) }, { get: () => ({ admit: true }) }])('fails closed when Connection is missing or unusable', ctx => {
    expect(makeUsageAccessGate(asContext(ctx), () => true)(remoteRequest())).toBe(403)
  })

  it('observes live opt-in changes and admission revocation, without caching owner grants', () => {
    let enabled = false
    let revoked = false
    const admit = vi.fn((_req: IncomingMessage) => revoked ? { rejection: 401 as const } : owner())
    const { ctx } = connectionContext(admit)
    const gate = makeUsageAccessGate(ctx, () => enabled)
    const req = remoteRequest({ cookie: 'session=previously-valid' })
    expect(gate(req)).toBe(403)
    enabled = true
    expect(gate(req)).toBeUndefined()
    revoked = true
    expect(gate(req)).toBe(401)
    enabled = false
    expect(gate(req)).toBe(403)
    expect(admit).toHaveBeenCalledTimes(2)
  })
})

describe.each(factories)('%s route access', (_name, factory) => {
  it('defaults to the old loopback policy and refuses unpaired proxy traffic', async () => {
    const service = usageService()
    const route = factory(asContext({}), service.service)
    const http = await serve(route)
    const path = route.path + '?date=2026-11-09'
    const method = factory === makeUsageRefreshRoute ? 'POST' : 'GET'
    expect((await http.send(path, method)).status).toBe(200)
    service.overview.mockClear()
    service.day.mockClear()
    service.refresh.mockClear()
    expect((await http.send(path, method, { 'x-forwarded-for': '203.0.113.7' })).status).toBe(403)
    expect(service.overview).not.toHaveBeenCalled()
    expect(service.day).not.toHaveBeenCalled()
    expect(service.refresh).not.toHaveBeenCalled()
  })

  it('defaults to live pairing when a proxied browser is paired', async () => {
    let paired = true
    const ctx = asContext({ get: (name: string) => name === 'remoteWebUiPairing' ? { isPairedDevice: () => paired } : undefined })
    const route = factory(ctx, usageService().service)
    const http = await serve(route)
    const path = route.path + '?date=2026-11-09'
    const method = factory === makeUsageRefreshRoute ? 'POST' : 'GET'
    const headers = { cookie: 'paired-device=live', 'x-forwarded-for': '203.0.113.7' }
    expect((await http.send(path, method, headers)).status).toBe(200)
    paired = false
    expect((await http.send(path, method, headers)).status).toBe(403)
  })

  it.each([401, 403] as const)('returns injected rejection %i before services, invalid date, or method checks', async status => {
    const service = usageService()
    const gate = vi.fn<Gate>(() => status)
    const route = factory(asContext({}), service.service, gate)
    const http = await serve(route)
    const response = await http.send(route.path + '?date=not-a-date', 'GET')
    expect(response.status).toBe(status)
    expect(response.body).toMatchObject({ ok: false })
    expect(gate).toHaveBeenCalledTimes(1)
    expect(service.overview).not.toHaveBeenCalled()
    expect(service.day).not.toHaveBeenCalled()
    expect(service.refresh).not.toHaveBeenCalled()
    expect(http.failures).toEqual([])
  })

  it('does not even read route input or service members before rejecting', async () => {
    const unexpected = () => { throw new Error('input/service accessed before authorization') }
    const req = { get url() { return unexpected() }, get method() { return unexpected() } } as unknown as IncomingMessage
    const service = new Proxy({}, { get: unexpected }) as UsageService
    const gate = vi.fn<Gate>(() => 401)
    const route = factory(asContext({}), service, gate)
    const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as ServerResponse
    await route.handler(req, res)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(gate.mock.calls[0]?.[0]).toBe(req)
    expect(res.writeHead).toHaveBeenCalledWith(401, expect.any(Object))
    expect(res.end).toHaveBeenCalledTimes(1)
  })

  it('admits a remote owner through the supplied gate and rejects revoked credentials on the same route', async () => {
    let revoked = false
    const admit = vi.fn((_req: IncomingMessage) => revoked ? { rejection: 401 as const } : owner())
    const { ctx } = connectionContext(admit)
    const route = factory(ctx, usageService().service, makeUsageAccessGate(ctx, () => true))
    const http = await serve(route)
    const path = route.path + '?date=2026-11-09'
    const method = factory === makeUsageRefreshRoute ? 'POST' : 'GET'
    const headers = { host: 'usage.example.test', authorization: 'Bearer browser-token', origin: 'https://usage.example.test', 'x-forwarded-for': '203.0.113.7' }
    expect((await http.send(path, method, headers)).status).toBe(200)
    expect(admit.mock.calls[0]?.[0]).toMatchObject({ headers })
    revoked = true
    expect((await http.send(path, method, headers)).status).toBe(401)
  })
})

describe('authorized usage route behavior', () => {
  const allow: Gate = () => undefined

  it('serves the overview unchanged and marks it no-store', async () => {
    const service = usageService()
    const http = await serve(makeUsageOverviewRoute(asContext({}), service.service, allow))
    const response = await http.send()
    expect(response.status).toBe(200)
    expect(response.body).toEqual(service.overviewValue)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(service.overview).toHaveBeenCalledExactlyOnceWith()
  })

  it('serves a valid day with the existing response envelope and no-store', async () => {
    const service = usageService()
    const route = makeUsageDayRoute(asContext({}), service.service, allow)
    const http = await serve(route)
    const response = await http.send(route.path + '?date=2026-11-09')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ ok: true, day: service.dayValue })
    expect(response.headers['cache-control']).toBe('no-store')
    expect(service.day).toHaveBeenCalledExactlyOnceWith('2026-11-09')
  })

  it.each(['', 'not-a-date', '2026-02-30', '2026-13-01'])('refuses invalid day %j with 400 without reading the service', async date => {
    const service = usageService()
    const route = makeUsageDayRoute(asContext({}), service.service, allow)
    const http = await serve(route)
    const response = await http.send(route.path + (date ? '?date=' + date : ''))
    expect(response.status).toBe(400)
    expect(response.body).toMatchObject({ ok: false })
    expect(service.day).not.toHaveBeenCalled()
  })

  it('rejects refresh GET with 405 without refreshing or reading the overview', async () => {
    const service = usageService()
    const http = await serve(makeUsageRefreshRoute(asContext({}), service.service, allow))
    const response = await http.send()
    expect(response.status).toBe(405)
    expect(response.body).toMatchObject({ ok: false })
    expect(service.refresh).not.toHaveBeenCalled()
    expect(service.overview).not.toHaveBeenCalled()
  })

  it('awaits refresh POST before reading and returning the overview', async () => {
    const service = usageService()
    let refreshed = false
    service.refresh.mockImplementation(async () => { await Promise.resolve(); refreshed = true })
    service.overview.mockImplementation(() => {
      expect(refreshed).toBe(true)
      return service.overviewValue
    })
    const route = makeUsageRefreshRoute(asContext({}), service.service, allow)
    const http = await serve(route)
    const response = await http.send(route.path, 'POST')
    expect(response.status).toBe(200)
    expect(response.body).toEqual(service.overviewValue)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(service.refresh).toHaveBeenCalledExactlyOnceWith()
    expect(service.overview).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([['refresh', makeUsageRefreshRoute]] as const)('retains JSON 500 for %s probe errors', async (_name, factory) => {
    const service = usageService()
    const fail = () => { throw new Error('usage service unavailable') }
    service.overview.mockImplementation(fail)
    service.day.mockImplementation(fail)
    service.refresh.mockRejectedValue(new Error('usage service unavailable'))
    const route = factory(asContext({}), service.service, allow)
    const http = await serve(route)
    const response = await http.send(route.path + '?date=2026-11-09', factory === makeUsageRefreshRoute ? 'POST' : 'GET')
    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ ok: false, error: expect.any(String) })
    expect(http.failures).toEqual([])
  })

  it('preserves host-level propagation when an overview read after refresh fails', async () => {
    const service = usageService()
    service.overview.mockImplementation(() => { throw new Error('overview unavailable') })
    const route = makeUsageRefreshRoute(asContext({}), service.service, allow)
    const http = await serve(route)
    const response = await http.send(route.path, 'POST')
    // Existing route leaves unexpected overview errors to the Host carrier.
    // The test harness deliberately records this as 599, not a route response.
    expect(response.status).toBe(599)
    expect(service.refresh).toHaveBeenCalledTimes(1)
    expect(http.failures).toHaveLength(1)
  })
})
