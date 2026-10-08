import { expect, test } from 'bun:test'
import { Store } from '../../src/state/database'
import { ingestPending } from '../../src/worker/mail-loop'
import { validateConfig } from '../../src/core/config'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
const request = { id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['git push *'], always: ['git push *'], metadata: { command: 'git push' } }
const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' } })
test('permission email controls route directly and unrelated text cannot become a paused-session prompt', async () => {
  const store = new Store(':memory:', config.recipients)
  try {
    store.registerSession(route, 'P', 'S'); store.permissions.sync(route, [request])
    const notification = store.deliveries()[0]; store.finishDelivery(notification, 'sent')
    const receive = (id: string, text: string, sender = 'me@example.com', refs = notification.messageId) => store.ingest(id, Buffer.from(`From: ${sender}\r\nMessage-ID: <${id}@example.com>\r\nIn-Reply-To: ${refs}\r\nContent-Type: text/plain\r\n\r\n${text}`).toString('base64'))
    receive('unknown', '!opencode-email-sync permission always', 'evil@example.com')
    receive('prose', 'Go ahead and do it')
    receive('mismatch', '!opencode-email-sync permission once per_other')
    await ingestPending(store, config)
    expect(store.permissions.claim(route, 'adapter')).toBeNull()
    expect(store.claim(route, 'adapter')).toBeNull()
    expect(store.deliveries().some(mail => mail.text.includes('!opencode-email-sync permission once'))).toBe(true)
    receive('valid', '!opencode-email-sync permission once')
    await ingestPending(store, config)
    expect(store.permissions.claim(route, 'adapter')?.requestId).toBe('per_a')
    expect(store.claim(route, 'adapter')).toBeNull()
  } finally { store.close() }
})
test('permission command in an ordinary answer thread is rejected instead of guessed', async () => {
  const store = new Store(':memory:', config.recipients)
  try {
    store.registerSession(route, 'P', 'S'); store.answer({ route, turnId: 'turn', project: 'P', title: 'S', text: 'Done' })
    const answer = store.deliveries()[0]; store.finishDelivery(answer, 'sent')
    store.permissions.sync(route, [request])
    store.ingest('not-bound', Buffer.from(`From: me@example.com\r\nIn-Reply-To: ${answer.messageId}\r\nContent-Type: text/plain\r\n\r\n!opencode-email-sync permission always`).toString('base64'))
    await ingestPending(store, config)
    expect(store.permissions.claim(route, 'adapter')).toBeNull()
    expect(store.deliveries().some(mail => mail.control && mail.text.includes('Reply to the permission email'))).toBe(true)
  } finally { store.close() }
})
