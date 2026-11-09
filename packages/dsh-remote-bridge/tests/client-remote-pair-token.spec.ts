import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalHttpsOrigin, mintRemoteToken, readRemoteInfo } from '../src/client/remote-pair.ts'
import { readPairToken } from '../src/client/pair-token.ts'

const ORIGIN = 'https://approved.example.test'
const TOKEN = 'test-token'
const URL = `wss://approved.example.test/ios/v1?token=${TOKEN}`
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body })
const valid = () => ({ token: TOKEN, expiresAt: Date.now() + 30_000, origin: ORIGIN, originSource: 'configured', pairingUrl: URL })
afterEach(() => { vi.unstubAllGlobals() })

describe('remote pairing transport', () => {
  it.each(['http://example.test', 'https://example.test/', 'https://user:password@example.test', 'https://example.test/path', 'https://example.test?query', 'https://*.example.test', 'https://EXAMPLE.test', 'not an origin'])('rejects noncanonical or unsafe metadata origin %s', async (origin) => {
    expect(canonicalHttpsOrigin(origin)).toBe(false)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ enabled: true, trustedOrigins: [origin] })))
    expect(await readRemoteInfo(new AbortController().signal)).toEqual({ kind: 'failed' })
  })
  it('accepts only the server-approved configured ticket and ignores legacy url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...valid(), url: 'ws://legacy.invalid' })))
    expect(await mintRemoteToken(ORIGIN, new AbortController().signal)).toMatchObject({ kind: 'ok', token: TOKEN, origin: ORIGIN, originSource: 'configured', pairingUrl: URL })
  })
  it.each([
    { origin: 'https://other.example.test' },
    { originSource: 'env' },
    { pairingUrl: `wss://other.example.test/ios/v1?token=${TOKEN}` },
    { pairingUrl: URL + '&extra=true' },
    { token: '' },
    { expiresAt: 'tomorrow' },
    { kind: 'ok' },
  ])('rejects invalid or differently addressed tickets: %j', async (override) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ ...valid(), ...override })))
    expect(await mintRemoteToken(ORIGIN, new AbortController().signal)).toEqual({ kind: 'failed' })
  })
  it.each([
    [401, {}, 'unauthorized'],
    [403, { enabled: false }, 'disabled'],
    [403, { error: 'untrusted-origin' }, 'unknownOrigin'],
    [403, { error: 'forbidden' }, 'forbidden'],
    [500, {}, 'failed'],
  ] as const)('maps server rejection %s to useful state', async (status, body, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(body, status)))
    expect(await mintRemoteToken(ORIGIN, new AbortController().signal)).toMatchObject({ kind })
  })
  it('keeps the configured source in the additive local parser', async () => {
    expect(await readPairToken({ fetchImpl: async () => reply(valid()) })).toMatchObject({ kind: 'ok', originSource: 'configured' })
  })
  it('does not let malformed metadata impersonate a trusted parsed outcome', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply({ kind: 'ok', trustedOrigins: [ORIGIN] })))
    expect(await readRemoteInfo(new AbortController().signal)).toEqual({ kind: 'failed' })
  })
})
