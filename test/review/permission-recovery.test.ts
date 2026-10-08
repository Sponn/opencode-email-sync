import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/state/database'
import { dispatchPermission } from '../../src/opencode/permissions'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
const request = { id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['git push'], always: ['git push'], metadata: {} }
function preparing(store: Store) {
  store.registerSession(route, 'P', 'S'); store.permissions.sync(route, [request])
  store.permissions.decide(route, 'once', { requestId: 'per_a', sender: 'me@example.com' })
  const first = store.permissions.claim(route, 'first')!
  store.permissions.begin(first.id, 'first'); store.disconnect('first')
  return first
}
test('a second adapter disconnect does not turn a reconciliation into a fresh approval', async () => {
  const store = new Store(':memory:', ['me@example.com'])
  try {
    preparing(store)
    expect(store.permissions.claim(route, 'second')?.status).toBe('reconcile')
    store.disconnect('second')
    const third = store.permissions.claim(route, 'third')!
    expect(third.status).toBe('reconcile')
    let replies = 0
    expect(await dispatchPermission({ async list() { return [request] }, async reply() { replies++; return 'accepted' } }, third, async () => true)).toBe('uncertain')
    expect(replies).toBe(0)
  } finally { store.close() }
})
test('restart while a reconciliation is leased preserves prior remote uncertainty', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-permission-recovery-')); const path = join(directory, 'state.sqlite')
  try {
    const first = new Store(path, ['me@example.com']); preparing(first)
    expect(first.permissions.claim(route, 'replacement')?.status).toBe('reconcile'); first.close()
    const second = new Store(path, ['me@example.com'])
    expect(second.permissions.claim(route, 'after-restart')?.status).toBe('reconcile'); second.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('permission uncertainty is observable and explicit cancellation releases a held request', () => {
  const store = new Store(':memory:', ['me@example.com'])
  try {
    const job = preparing(store); const recovery = store.permissions.claim(route, 'replacement')!
    store.permissions.ack(recovery.id, 'replacement', 'uncertain')
    expect(store.status().uncertain).toContainEqual({ id: job.id, kind: 'permission' })
    store.resolve(job.id, 'retry')
    expect(store.permissions.claim(route, 'retry')?.status).toBe('reconcile')
    store.permissions.ack(job.id, 'retry', 'uncertain')
    store.resolve(job.id, 'cancel')
    expect(store.permissions.status(job.id)?.status).toBe('canceled')
    expect(store.permissions.decide(route, 'reject', { requestId: 'per_a' }).ok).toBe(true)
  } finally { store.close() }
})
