import { expect, test } from 'bun:test'
import { Store } from '../../src/state/database'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
test('successive answers keep recipient-scoped email threads and reject conflicting routes', () => {
  const store = new Store(':memory:', ['me@example.com', 'second@example.com'])
  store.registerSession(route, 'P', 'S')
  store.answer({ route, turnId: 'turn-a', text: 'First', project: 'P', title: 'S' })
  const first = store.deliveries()
  for (const delivery of first) store.finishDelivery(delivery, 'sent')
  store.answer({ route, turnId: 'turn-b', text: 'Second', project: 'P', title: 'S' })
  const next = store.deliveries()
  expect(next.find(mail => mail.recipient === 'me@example.com')?.references).toBe(first.find(mail => mail.recipient === 'me@example.com')?.messageId)
  expect(next.find(mail => mail.recipient === 'second@example.com')?.references).toBe(first.find(mail => mail.recipient === 'second@example.com')?.messageId)
  expect(store.thread([first[0].messageId], 'evil@example.com')).toBeNull()
  const other = { ...route, sessionId: 'ses_b' }
  store.answer({ route: other, turnId: 'turn-c', text: 'Other', project: 'P', title: 'S' })
  const notification = store.deliveries().find(mail => mail.route.sessionId === 'ses_b')!
  store.finishDelivery(notification, 'sent')
  expect(store.thread([first[0].messageId, notification.messageId])).toBeNull()
  store.close()
})
