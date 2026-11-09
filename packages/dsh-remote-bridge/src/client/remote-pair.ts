/** Owner-gated remote pairing. Metadata never issues a secret. */
import type { PairTokenOutcome } from './pair-token.ts'

export type RemotePairError = 'disabled' | 'unauthorized' | 'forbidden' | 'unknownOrigin' | 'failed' | 'unreachable'
export type RemoteInfo = { kind: 'ok'; trustedOrigins: string[] } | { kind: RemotePairError; status?: number }
export type RemoteTicket = Extract<PairTokenOutcome, { kind: 'ok' }> | { kind: RemotePairError; status?: number }

/** Only exact canonical HTTPS origins are accepted; paths and credentials are not origins. */
export function canonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('*')) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
  } catch { return false }
}

async function request(path: string, signal: AbortSignal, origin?: string): Promise<unknown> {
  const response = await fetch(`remote-bridge/pair/${path}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
    ...(origin === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ origin }) }),
  })
  if (response.status === 401) return { kind: 'unauthorized' }
  if (response.status === 403) {
    let body: unknown
    try { body = await response.json() } catch { return { kind: 'forbidden' } }
    if (typeof body === 'object' && body !== null) {
      if ((body as { enabled?: unknown }).enabled === false) return { kind: 'disabled' }
      if ((body as { error?: unknown }).error === 'untrusted-origin') return { kind: 'unknownOrigin' }
    }
    return { kind: 'forbidden' }
  }
  if (!response.ok) return { kind: response.status === 400 ? 'unknownOrigin' : 'failed', status: response.status }
  const data: unknown = await response.json()
  // Do not let a malformed success body impersonate an internal parsed outcome.
  if (typeof data === 'object' && data !== null && 'kind' in data) return { kind: 'failed' }
  return data
}

export async function readRemoteInfo(signal: AbortSignal): Promise<RemoteInfo> {
  try {
    const body = await request('remote-info', signal) as Record<string, unknown>
    if (typeof body !== 'object' || body === null) return { kind: 'failed' }
    if (typeof body['kind'] === 'string') return body as RemoteInfo
    if (body['enabled'] === false) return { kind: 'disabled' }
    if (body['enabled'] !== true || !Array.isArray(body['trustedOrigins']) || !body['trustedOrigins'].every(canonicalHttpsOrigin)) return { kind: 'failed' }
    if (body['trustedOrigins'].length === 0) return { kind: 'disabled' }
    return { kind: 'ok', trustedOrigins: [...new Set(body['trustedOrigins'])] }
  } catch { return { kind: 'unreachable' } }
}

export async function mintRemoteToken(origin: string, signal: AbortSignal): Promise<RemoteTicket> {
  try {
    const body = await request('remote-token', signal, origin) as Record<string, unknown>
    if (typeof body !== 'object' || body === null) return { kind: 'failed' }
    if (typeof body['kind'] === 'string') return body as RemoteTicket
    if (body['origin'] !== origin || body['originSource'] !== 'configured' || !canonicalHttpsOrigin(origin)
      || typeof body['token'] !== 'string' || !body['token'] || typeof body['expiresAt'] !== 'number' || !Number.isFinite(body['expiresAt'])) return { kind: 'failed' }
    const expected = new URL('/ios/v1', origin)
    expected.protocol = 'wss:'
    expected.searchParams.set('token', body['token'])
    if (body['pairingUrl'] !== expected.href) return { kind: 'failed' }
    return { kind: 'ok', token: body['token'], expiresAt: body['expiresAt'], origin, originSource: 'configured', pairingUrl: body['pairingUrl'] as string }
  } catch { return { kind: 'unreachable' } }
}
