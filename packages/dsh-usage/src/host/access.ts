/**
 * Usage trust fence: preserve loopback and live paired-device admission, with
 * a separate default-off path delegated to the Host's live Connection policy.
 */
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { isPairedOrLoopbackAllowed } from './pair-access.ts'

/** Undefined admits a request; rejection preserves the HTTP authentication status. */
export type UsageAccessGate = (request: IncomingMessage) => 401 | 403 | undefined

/**
 * Whether this request may read the usage overview or trigger a refresh.
 * @param ctx - host context; may expose remoteWebUiPairing.
 * @param request - the incoming HTTP request.
 * @returns true for loopback, or a live paired-device cookie.
 */
export function isUsageAllowed(ctx: Context, request: IncomingMessage): boolean {
  return isPairedOrLoopbackAllowed(ctx, request)
}

/**
 * Keep the original fence first, then optionally admit authenticated owner
 * Peers. Read both the opt-in and optional Connection for each remote request,
 * so disabling access or unloading Connection takes effect without remounting.
 * The unchanged request goes to Connection: Host/Origin and credentials remain
 * its responsibility. Missing, incompatible or failing admission denies access.
 */
export function makeUsageAccessGate(ctx: Context, allowAuthenticatedRemote: () => boolean): UsageAccessGate {
  return (request) => {
    try {
      if (isUsageAllowed(ctx, request)) return undefined
      if (allowAuthenticatedRemote() !== true) return 403
      const connection = (typeof ctx.get === 'function' ? ctx.get('connection', false) : undefined) as
        Pick<HostConnectionHandle, 'admit'> | undefined
      if (typeof connection?.admit !== 'function') return 403
      const admission = connection.admit(request)
      if ('rejection' in admission) return admission.rejection === 401 ? 401 : 403
      return admission.peer.principal.kind === 'owner' ? undefined : 403
    } catch {
      return 403
    }
  }
}
