import { expect, test } from 'bun:test'
import { Store } from '../../src/state/database'
import { persistFetched, checkpointStart, imapOptions } from '../../src/mail/imap'
import { validateConfig } from '../../src/core/config'
test('mailbox baselines history, commits mail before UID checkpoint, and deduplicates UID resets', async () => {
  const store = new Store(':memory:', ['me@example.com'])
  expect(checkpointStart(store, 'INBOX', '1', 101)).toBe(101)
  const raw = Buffer.from('Message-ID: <one@example.com>\r\nFrom: me@example.com\r\n\r\nContinue')
  await persistFetched(store, 'INBOX', '1', 101, raw, 100000)
  expect(store.pendingMail().length).toBe(1)
  expect(checkpointStart(store, 'INBOX', '1', 102)).toBe(102)
  expect(checkpointStart(store, 'INBOX', '2', 200)).toBe(1)
  await persistFetched(store, 'INBOX', '2', 7, raw, 100000)
  expect(store.pendingMail().length).toBe(1)
  expect(checkpointStart(store, 'INBOX', '2', 200)).toBe(8)
  store.close()
})
test('IMAP explicitly requires STARTTLS rather than opportunistic downgrade', () => {
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 143, username: 'bot', passwordEnv: 'PASS', security: 'starttls' } })
  const options = imapOptions(config, 'test')
  expect(options.doSTARTTLS).toBe(true)
  expect(options.secure).toBe(false)
  expect(options.tls?.rejectUnauthorized).toBe(true)
})
