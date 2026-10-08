import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/state/database'
import type { PermissionRequest } from '../../src/core/types'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
const request: PermissionRequest = { id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['git push *'], always: ['git push *'], metadata: { command: 'git push origin main' } }
function sentNotification(store: Store) {
  const mail = store.deliveries()[0]; store.finishDelivery(mail, 'sent'); return mail
}
test('permission notification deduplicates and its thread binds the specific request', () => {
  const store = new Store(':memory:', ['me@example.com'])
  try {
    store.registerSession(route, 'Project', 'Session')
    store.permissions.sync(route, [request]); store.permissions.sync(route, [request])
    expect(store.deliveries()).toHaveLength(1)
    const notification = sentNotification(store)
    const thread = store.thread([notification.messageId], 'me@example.com')!
    expect(thread.permissionKey).toBeDefined()
    expect(store.permissions.request(thread.permissionKey!)?.id).toBe('per_a')
    const first = store.permissions.decide(route, 'once', { key: thread.permissionKey, sender: 'me@example.com', replyId: '<reply@example.com>' })
    expect(first.ok).toBe(true)
    expect(store.permissions.decide(route, 'reject', { key: thread.permissionKey, sender: 'me@example.com' }).ok).toBe(false)
    const job = store.permissions.claim(route, 'adapter')!
    expect(job.action).toBe('once')
    expect(store.permissions.claim(route, 'another-adapter')).toBeNull()
    expect(store.permissions.begin(job.id, 'adapter')).toBe(true)
    store.permissions.ack(job.id, 'adapter', 'accepted')
    expect(store.deliveries()[0].text).toContain('approved once')
    expect(store.deliveries()[0].recipient).toBe('me@example.com')
  } finally { store.close() }
})
test('already answered request never redirects an old reply onto a new permission', () => {
  const store = new Store(':memory:', ['me@example.com'])
  try {
    store.registerSession(route, 'Project', 'Session'); store.permissions.sync(route, [request])
    const old = sentNotification(store)
    store.permissions.sync(route, [{ ...request, id: 'per_b' }])
    const result = store.permissions.decide(route, 'always', { key: old.permissionKey, sender: 'me@example.com' })
    expect(result.ok).toBe(false)
    expect(result.message).toContain('already answered or expired')
    expect(store.permissions.claim(route, 'adapter')).toBeNull()
    expect(store.permissions.decide(route, 'once', { requestId: 'per_b', sender: 'me@example.com' }).ok).toBe(true)
    expect(store.permissions.claim(route, 'adapter')?.requestId).toBe('per_b')
  } finally { store.close() }
})
test('off cancels undispatched decisions and notifications, and no approval is possible until on', () => {
  const store = new Store(':memory:', ['me@example.com'])
  try {
    store.registerSession(route, 'P', 'S'); store.permissions.sync(route, [request]); const notification = sentNotification(store)
    store.permissions.decide(route, 'once', { key: notification.permissionKey })
    const job = store.permissions.claim(route, 'adapter')!
    store.setPolicy(route, false); store.setPolicy(route, true)
    expect(store.permissions.begin(job.id, 'adapter')).toBe(false)
    expect(store.permissions.decide(route, 'reject', { key: notification.permissionKey }).ok).toBe(true)
    store.setPolicy(route, false)
    expect(store.permissions.decide(route, 'once', { key: notification.permissionKey }).message).toContain('OFF')
  } finally { store.close() }
})
test('shell permission commands require an ID when multiple requests are pending', () => {
  const store = new Store(':memory:', [])
  try {
    store.registerSession(route, 'P', 'S'); store.permissions.sync(route, [request, { ...request, id: 'per_b' }])
    expect(store.permissions.decide(route, 'once').message).toContain('request ID')
    expect(store.permissions.decide({ ...route, sessionId: 'ses_other' }, 'once', { requestId: 'per_a' }).ok).toBe(false)
  } finally { store.close() }
})
test('permission delivery/decision migrates an existing database and uncertain outcomes remain request-specific', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-permission-state-')); const path = join(directory, 'state.sqlite')
  try {
    const first = new Store(path, ['me@example.com']); first.registerSession(route, 'P', 'S'); first.permissions.sync(route, [request])
    const notification = sentNotification(first)
    first.permissions.decide(route, 'once', { key: notification.permissionKey, sender: 'me@example.com' })
    const job = first.permissions.claim(route, 'adapter')!
    first.permissions.begin(job.id, 'adapter'); first.close()
    const second = new Store(path, ['me@example.com'])
    expect(second.permissions.claim(route, 'replacement')?.status).toBe('reconcile')
    second.permissions.ack(job.id, 'replacement', 'stale')
    expect(second.deliveries()[0].text).toContain('already answered or expired')
    second.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('permission snapshots from another live server cannot expire the owning server request', () => {
  const store = new Store(':memory:', ['me@example.com'])
  try {
    store.registerSession(route, 'P', 'S'); const active = new Set(['owner', 'other'])
    store.permissions.sync(route, [request], 'owner', active)
    store.permissions.sync(route, [], 'other', active)
    expect(store.permissions.decide(route, 'once', { requestId: 'per_a' }).ok).toBe(true)
    expect(store.permissions.claim(route, 'other')).toBeNull()
    expect(store.permissions.claim(route, 'owner')?.requestId).toBe('per_a')
  } finally { store.close() }
})
test('new requests while sync is off produce no mail until syncing is enabled', () => {
  const store = new Store(':memory:', ['me@example.com'])
  try {
    store.registerSession(route, 'P', 'S'); store.setPolicy(route, false); store.permissions.sync(route, [request])
    expect(store.deliveries()).toEqual([])
    store.setPolicy(route, true); store.permissions.sync(route, [request])
    expect(store.deliveries()).toHaveLength(1)
    const old = sentNotification(store)
    store.permissions.sync(route, [{ ...request, id: 'per_b' }]); const next = sentNotification(store)
    expect(store.thread([old.messageId, next.messageId], 'me@example.com')).toBeNull()
  } finally { store.close() }
})
