import type { PermissionGateway } from './permission-api'
import type { PermissionJob } from '../core/types'
import type { PermissionOutcome } from '../state/permissions'

export async function dispatchPermission(gateway: PermissionGateway, job: PermissionJob, authorize: () => Promise<boolean>): Promise<PermissionOutcome> {
  let submitting = false
  try {
    const pending = await gateway.list()
    const targetSessionId = job.targetSessionId || job.route.sessionId
    if (!pending.some(request => request.id === job.requestId && request.sessionID === targetSessionId)) return 'stale'
    if (job.status === 'reconcile') return 'uncertain'
    if (!(await authorize())) return 'canceled'
    submitting = true
    return await gateway.reply(targetSessionId, job.requestId, job.action)
  } catch { return submitting || job.status === 'reconcile' ? 'uncertain' : 'queued' }
}
