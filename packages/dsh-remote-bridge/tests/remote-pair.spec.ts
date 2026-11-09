import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PairingService } from '../src/core/pairing.ts'
import { makeRemotePairRoutes, REMOTE_PAIR_INFO_PATH as INFO, REMOTE_PAIR_TOKEN_PATH as TOKEN, resolveRemotePairConfig, type RemotePairConnection } from '../src/host/remote-pair.ts'

const browser = 'https://console.example.test'
const approved = 'https://bridge.example.test:8443'
const owner = { peer: { principal: { kind: 'owner' } } }
const servers: Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))) })

async function fixture(initial: unknown = { remotePairingEnabled: true, trustedPairingOrigins: [approved] }) {
  let config = initial
  let connection: RemotePairConnection | undefined = { admit: () => owner }
  const pairing = new PairingService()
  const mint = vi.spyOn(pairing, 'issueToken')
  const seen: IncomingMessage[] = []
  let bodyReads = 0
  const routes = makeRemotePairRoutes({ pairing, config: () => config, getConnection: () => connection })
  const server = createServer((req, res) => {
    seen.push(req)
    const original = req.on
    req.on = function (this: IncomingMessage, event: string, ...args: unknown[]) {
      if (event === 'data') bodyReads++
      return Reflect.apply(original, this, [event, ...args])
    } as typeof req.on
    const route = routes.find(route => 'path' in route && route.path === req.url)
    if (route) void route.handler(req, res)
    else { res.statusCode = 404; res.end() }
  })
  servers.push(server)
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const call = (path = INFO, options: { method?: string; headers?: Record<string, string | undefined>; body?: string; chunks?: string[]; omitOrigin?: boolean } = {}) => new Promise<{ status: number; body: Record<string, unknown>; headers: IncomingMessage['headers'] }>((resolve, reject) => {
    const post = path === TOKEN
    const req = request({ hostname: '127.0.0.1', port, path, method: options.method ?? (post ? 'POST' : 'GET'), headers: {
      host: 'console.example.test', ...(post && !options.omitOrigin ? { origin: browser, 'content-type': 'application/json' } : {}), ...options.headers,
    } }, res => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        expect(res.headers['cache-control']).toBe('no-store')
        expect(res.headers['referrer-policy']).toBe('no-referrer')
        resolve({ status: res.statusCode!, body: JSON.parse(body), headers: res.headers })
      })
    })
    req.on('error', reject)
    if (options.chunks) { for (const chunk of options.chunks) req.write(chunk); req.end() }
    else req.end(options.body ?? (post ? JSON.stringify({ origin: approved }) : undefined))
  })
  return { call, mint, pairing, port, seen, bodyReads: () => bodyReads, setConfig: (value: unknown) => { config = value }, setConnection: (value: RemotePairConnection | undefined) => { connection = value } }
}

async function unfinishedUpload(port: number, chunk: string): Promise<{ status: number; connection: string | undefined }> {
  return new Promise((resolve, reject) => {
    let result: { status: number; connection: string | undefined } | undefined
    const req = request({ hostname: '127.0.0.1', port, path: TOKEN, method: 'POST', headers: {
      host: 'console.example.test', origin: browser, 'content-type': 'application/json', connection: 'keep-alive',
    } }, res => {
      result = { status: res.statusCode!, connection: res.headers.connection }
      res.resume()
    })
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Rejected upload was left open')) }, 14000)
    req.on('socket', socket => socket.once('close', () => {
      clearTimeout(timer)
      if (result) resolve(result)
      else reject(new Error('Connection closed without a rejection response'))
    }))
    req.on('error', error => { if (!result) { clearTimeout(timer); reject(error) } })
    req.write(chunk) // Intentionally never end the upload.
  })
}

describe('remote pairing HTTP admission', () => {
  it('closes an unended oversized chunked upload after returning its denial', async () => {
    const f = await fixture()
    expect(await unfinishedUpload(f.port, 'x'.repeat(1025))).toEqual({ status: 413, connection: 'close' })
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('closes an unended slow upload after the body deadline', async () => {
    const f = await fixture()
    expect(await unfinishedUpload(f.port, '{')).toEqual({ status: 408, connection: 'close' })
    expect(f.mint).not.toHaveBeenCalled()
  }, 15000)

  it('refresh retires only the previous remote code, not independent local codes', async () => {
    const f = await fixture()
    const local = f.pairing.issueToken()
    const first = await f.call(TOKEN)
    const second = await f.call(TOKEN)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(f.pairing.consumeToken(String(first.body.token))).toBe(false)
    expect(f.pairing.consumeToken(local.value)).toBe(true)
    expect(f.pairing.consumeToken(String(second.body.token))).toBe(true)
    expect(f.pairing.consumeToken(String(second.body.token))).toBe(false)
  })

  it('a rejected request or failed mint does not retire the previous live remote code', async () => {
    const f = await fixture()
    const first = await f.call(TOKEN)
    expect((await f.call(TOKEN, { body: JSON.stringify({ origin: 'https://untrusted.example' }) })).status).toBe(403)
    f.mint.mockImplementationOnce(() => { throw new Error('unavailable') })
    expect((await f.call(TOKEN)).status).toBe(503)
    expect(f.pairing.consumeToken(String(first.body.token))).toBe(true)
  })

  it('defaults off and reads configuration and connection anew for each request', async () => {
    const f = await fixture({})
    expect(await f.call()).toMatchObject({ status: 403, body: { enabled: false, trustedOrigins: [] } })
    f.setConfig({ remotePairingEnabled: true, trustedPairingOrigins: [approved] })
    expect(await f.call()).toMatchObject({ status: 200, body: { enabled: true, trustedOrigins: [approved] } })
    f.setConnection(undefined)
    expect((await f.call()).status).toBe(403)
    f.setConnection({ admit: () => owner })
    expect((await f.call()).status).toBe(200)
    f.setConfig({ remotePairingEnabled: false, trustedPairingOrigins: [approved] })
    expect((await f.call(TOKEN)).status).toBe(403)
    expect(f.mint).not.toHaveBeenCalled()
  })

  it.each([
    undefined, {}, null, { rejection: 401 }, { rejection: 403 }, { rejection: 500 },
    { rejection: undefined, ...owner }, { peer: {} }, { peer: { principal: { kind: 'api' } } },
    { peer: { principal: { kind: 'device' } } }, { peer: { principal: { kind: true } } },
    [], 'owner', true,
  ])('rejects malformed/non-owner admission %j before reading or minting', async admission => {
    const f = await fixture()
    f.setConnection({ admit: () => admission })
    expect((await f.call(TOKEN)).status).toBe(admission && typeof admission === 'object' && 'rejection' in admission && admission.rejection === 401 ? 401 : 403)
    expect(f.bodyReads()).toBe(0)
    expect(f.mint).not.toHaveBeenCalled()
  })

  it.each(['missing', 'throw', 'async-owner', 'async-rejection', 'getter-throw'])('fails closed for %s connection', async kind => {
    const f = await fixture()
    if (kind === 'missing') f.setConnection(undefined)
    if (kind === 'throw') f.setConnection({ admit: () => { throw Error('no') } })
    if (kind === 'async-owner') f.setConnection({ admit: async () => owner })
    if (kind === 'async-rejection') f.setConnection({ admit: async () => { throw Error('no') } })
    if (kind === 'getter-throw') f.setConnection({ get admit(): never { throw Error('no') } })
    expect((await f.call(TOKEN)).status).toBe(403)
    expect(f.bodyReads()).toBe(0)
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('passes the original IncomingMessage with credentials untouched and metadata never mints', async () => {
    const f = await fixture()
    const admit = vi.fn(() => owner)
    f.setConnection({ admit })
    const result = await f.call(INFO, { headers: { authorization: 'Bearer fixture-only', cookie: 'fixture=value' } })
    expect(result.body).toEqual({ enabled: true, trustedOrigins: [approved] })
    expect(admit).toHaveBeenCalledWith(f.seen[0])
    expect(f.seen[0]?.headers.authorization).toBe('Bearer fixture-only')
    expect(f.seen[0]?.headers.cookie).toBe('fixture=value')
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('mints only an approved wss address with the existing token fields', async () => {
    const f = await fixture()
    const result = await f.call(TOKEN)
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ origin: approved, originSource: 'configured' })
    expect(result.body.pairingUrl).toBe(`wss://bridge.example.test:8443/ios/v1?token=${result.body.token}`)
    expect(result.body.url).toBe(result.body.pairingUrl)
    expect(typeof result.body.expiresAt).toBe('number')
    expect(f.mint).toHaveBeenCalledTimes(1)
  })
})

describe('remote pairing CSRF and input fences', () => {
  it.each([
    { origin: 'https://other.example.test' }, { origin: 'null' }, { origin: 'http://console.example.test' },
    { origin: browser + '/' }, { origin: 'https://console.example.test:443' }, { origin: 'https://CONSOLE.example.test' },
    { origin: browser, host: 'other.example.test' }, { origin: browser, host: 'console.example.test/path' },
    { origin: browser, 'sec-fetch-site': 'cross-site' }, { origin: browser, 'sec-fetch-site': 'same-site' },
    { origin: 'null', 'x-forwarded-host': 'console.example.test', 'x-forwarded-proto': 'https' },
  ])('rejects bad Origin/Host/fetch metadata %j', async headers => {
    const f = await fixture()
    expect((await f.call(TOKEN, { headers })).status).toBe(403)
    expect(f.bodyReads()).toBe(0)
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('requires Origin on POST but allows same-origin browser GET without it', async () => {
    const f = await fixture()
    expect((await f.call(INFO, { headers: { 'sec-fetch-site': 'same-origin' } })).status).toBe(200)
    expect((await f.call(TOKEN, { omitOrigin: true })).status).toBe(403)
    expect((await f.call(INFO, { headers: { origin: 'https://other.example.test' } })).status).toBe(403)
    expect((await f.call(INFO, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
  })

  it.each([
    { method: 'GET', status: 405 }, { method: 'PUT', status: 405 },
    { headers: { 'content-type': 'text/plain' }, status: 415 },
    { headers: { 'content-type': 'application/jsonp' }, status: 415 },
    { body: '', status: 400 }, { body: '{', status: 400 }, { body: 'null', status: 400 },
    { body: '[]', status: 400 }, { body: '{}', status: 400 },
    { body: JSON.stringify({ origin: 'https://evil.example.test' }), status: 403 },
    { body: JSON.stringify({ origin: approved + '/' }), status: 400 },
    { body: JSON.stringify({ origin: approved, padding: 'x'.repeat(1024) }), status: 413 },
    { chunks: ['x'.repeat(600), 'x'.repeat(600)], status: 413 },
  ])('rejects bad request %#', async ({ status, ...options }) => {
    const f = await fixture()
    expect((await f.call(TOKEN, options)).status).toBe(status)
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('accepts small chunked JSON and bounds UTF-8 bytes rather than characters', async () => {
    const f = await fixture()
    const text = JSON.stringify({ origin: approved })
    expect((await f.call(TOKEN, { chunks: [text.slice(0, 8), text.slice(8)] })).status).toBe(200)
    f.mint.mockClear()
    expect((await f.call(TOKEN, { chunks: [JSON.stringify({ origin: approved, padding: '界'.repeat(400) })] })).status).toBe(413)
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('never lets client-supplied allowlists authorize an unconfigured origin', async () => {
    const f = await fixture()
    expect((await f.call(TOKEN, { body: JSON.stringify({ origin: 'https://other.example.test', trustedPairingOrigins: ['https://other.example.test'] }) })).status).toBe(403)
    expect(f.mint).not.toHaveBeenCalled()
  })

  it('advertises methods and accepts UTF-8 JSON and none metadata', async () => {
    const f = await fixture()
    expect(await f.call(INFO, { method: 'POST' })).toMatchObject({ status: 405, headers: { allow: 'GET' } })
    expect(await f.call(TOKEN, { headers: { 'content-type': 'application/json; charset=utf-8', 'sec-fetch-site': 'none' } })).toMatchObject({ status: 200 })
  })

  it('revocation during body upload denies before mint', async () => {
    const f = await fixture()
    let reads = 0
    const config = { get remotePairingEnabled() { reads++; return reads === 1 }, trustedPairingOrigins: [approved] }
    f.setConfig(config)
    expect((await f.call(TOKEN)).status).toBe(403)
    expect(f.mint).not.toHaveBeenCalled()
  })
})

describe('strict remote pairing config', () => {
  it.each([
    'http://bridge.example.test', 'https://bridge.example.test/', 'https://user@bridge.example.test',
    'https://bridge.example.test/path', 'https://bridge.example.test?query', 'https://bridge.example.test#hash',
    'https://*.example.test', 'https://BRIDGE.example.test', 'https://bridge.example.test:443',
    '//bridge.example.test', ' https://bridge.example.test', 'https://bridge.example.test\\evil', 'https://', '', null, 1,
  ])('disables for an invalid allowlist item %j', async origin => {
    const config = { remotePairingEnabled: true, trustedPairingOrigins: [approved, origin] }
    expect(resolveRemotePairConfig(config)).toEqual({ remotePairingEnabled: false, trustedPairingOrigins: [] })
    const f = await fixture(config)
    expect((await f.call(TOKEN)).status).toBe(403)
    expect(f.mint).not.toHaveBeenCalled()
  })
  it.each(['true', 'false', 1, null, [], {}])('never coerces flag %j', flag => {
    expect(resolveRemotePairConfig({ remotePairingEnabled: flag, trustedPairingOrigins: [approved] })).toEqual({ remotePairingEnabled: false, trustedPairingOrigins: [] })
  })
  it('defaults fields and snapshots only validated canonical origins', () => {
    expect(resolveRemotePairConfig({})).toEqual({ remotePairingEnabled: false, trustedPairingOrigins: [] })
    expect(resolveRemotePairConfig({ remotePairingEnabled: true })).toEqual({ remotePairingEnabled: true, trustedPairingOrigins: [] })
    expect(resolveRemotePairConfig({ remotePairingEnabled: true, trustedPairingOrigins: [approved, approved] })).toEqual({ remotePairingEnabled: true, trustedPairingOrigins: [approved] })
    expect(resolveRemotePairConfig({ remotePairingEnabled: true, trustedPairingOrigins: Array(2) }).remotePairingEnabled).toBe(false)
    expect(resolveRemotePairConfig({ remotePairingEnabled: true, trustedPairingOrigins: approved }).remotePairingEnabled).toBe(false)
  })
})
