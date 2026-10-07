import { expect, test } from 'bun:test'
import { Store } from '../../src/state/database'

const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
test('default-on persistent overrides cancel only pending work', () => {
  const store = new Store(':memory:', ['me@example.com'])
  expect(store.policy(route)).toBe(true)
  store.registerSession(route, 'Project', 'Session')
  store.answer({ route, turnId: 'msg_a', text: 'Done', project: 'Project', title: 'Session' })
  store.answer({ route, turnId: 'msg_a', text: 'Done', project: 'Project', title: 'Session' })
  expect(store.deliveries().length).toBe(1)
  const thread = store.deliveries()[0]
  store.finishDelivery(thread, 'sent')
  store.enqueue(route, 'reply-a', 'Continue', 'me@example.com')
  expect(store.claim(route, 'adapter')).not.toBeNull()
  expect(store.claim(route, 'other')).toBeNull()
  store.setPolicy(route, false)
  expect(store.deliveries().length).toBe(0)
  store.setPolicy(route, true)
  expect(store.deliveries().length).toBe(0)
  expect(store.thread([thread.messageId])?.route.sessionId).toBe('ses_a')
  store.close()
})
test('two projects and deduplicated mail stay independent', () => {
  const store = new Store(':memory:', ['me@example.com'])
  store.setPolicy(route, false)
  expect(store.policy({ ...route, projectId: 'other', directory: '/other' })).toBe(true)
  expect(store.ingest('mail-a', 'raw')).toBe(true)
  expect(store.ingest('mail-a', 'raw')).toBe(false)
  store.close()
})
