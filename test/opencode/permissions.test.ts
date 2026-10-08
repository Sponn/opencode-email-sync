import { expect, test } from 'bun:test'
import { dispatchPermission } from '../../src/opencode/permissions'
import type { PermissionJob } from '../../src/core/types'
const job: PermissionJob = { kind: 'permission', id: 'job', key: 'key', route: { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }, requestId: 'per_a', action: 'once', owner: 'adapter', status: 'queued' }
const request = { id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['git push'], always: ['git push'], metadata: {} }
test('permission dispatch checks the exact live request and bypasses the ordinary prompt loop', async () => {
  let replied: unknown
  const gateway = { async list() { return [request] }, async reply(sessionId: string, requestId: string, action: string) { replied = [sessionId, requestId, action]; return 'accepted' as const } }
  expect(await dispatchPermission(gateway, job, async () => true)).toBe('accepted')
  expect(replied).toEqual(['ses_a', 'per_a', 'once'])
  replied = undefined
  expect(await dispatchPermission({ ...gateway, async list() { return [{ ...request, id: 'per_new' }] } }, job, async () => true)).toBe('stale')
  expect(replied).toBeUndefined()
  expect(await dispatchPermission(gateway, job, async () => false)).toBe('canceled')
  expect(await dispatchPermission(gateway, { ...job, status: 'reconcile' }, async () => true)).toBe('uncertain')
  expect(await dispatchPermission({ ...gateway, async reply() { return 'stale' as const } }, job, async () => true)).toBe('stale')
})
test('permission outages before submission retry and uncertain remote acceptance is held', async () => {
  const gateway = { async list() { return [request] }, async reply() { throw new Error('Lost response') } }
  expect(await dispatchPermission(gateway, job, async () => true)).toBe('uncertain')
  expect(await dispatchPermission({ ...gateway, async list() { throw new Error('Offline') } }, job, async () => true)).toBe('queued')
})
