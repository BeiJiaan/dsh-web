/**
 * Archive HTTP admission. Keep the original local fence; remote access is a
 * separate, default-off opt-in delegated to the Host's live Connection policy.
 * @module @linxin666/dsh-session-archive/host/access
 */

import type { IncomingMessage } from 'node:http'
import type { HostConnectionHandle, ConnectionRequestRejection } from '@deepseek-ai/dsh-client-connection'
import { readConfigField, type SessionArchiveConfigFields } from '../core/config.ts'
import { isLoopbackRequest } from './loopback.ts'

/** Undefined admits a request; a rejection preserves the HTTP authentication status. */
export type ArchiveAccessGate = (req: IncomingMessage) => ConnectionRequestRejection | Promise<ConnectionRequestRejection>

/** Standalone route factories remain loopback-only unless explicitly given a gate. */
export const loopbackAccessGate: ArchiveAccessGate = (req) => isLoopbackRequest(req) ? undefined : 403

/**
 * Create a live policy without requiring Connection on older Hosts. Both the
 * volatile opt-in and optional active Connection are read for each remote
 * request, not captured as an authorization decision when routes are mounted.
 * The original request goes to official admission unchanged: Host/Origin and
 * credential validation belong to Connection, not forwarding-header heuristics.
 * Only owner Peers may manage archives; other principals and any unavailable,
 * incompatible or failing Connection are denied before a route reads its body.
 */
export function makeArchiveAccessGate(
  config: SessionArchiveConfigFields | undefined,
  getConnection: () => Pick<HostConnectionHandle, 'admit'> | undefined,
): ArchiveAccessGate {
  return (req) => {
    if (isLoopbackRequest(req)) return undefined
    try {
      // Strict opt-in also rejects malformed hand-written profile values.
      if (readConfigField(config?.allowAuthenticatedRemote) !== true) return 403
      const connection = getConnection()
      if (typeof connection?.admit !== 'function') return 403
      const admission = connection.admit(req)
      if ('rejection' in admission) return admission.rejection === 401 ? 401 : 403
      return admission.peer.principal.kind === 'owner' ? undefined : 403
    } catch {
      // Do not turn missing services, bad admission results or errors into access.
      return 403
    }
  }
}
