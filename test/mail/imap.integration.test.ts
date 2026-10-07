import { expect, test } from 'bun:test'
import { imapFixture } from '../fixtures/imap-server'
import { startImap } from '../../src/mail/imap'
import { Store } from '../../src/state/database'
import { validateConfig } from '../../src/core/config'
import { until } from '../fixtures/opencode'
test('real IMAP connection polls incoming mail, preserves history baseline and reconnects on UID reset', async () => {
  const fixture = await imapFixture()
  fixture.append('Message-ID: <old@example.com>\r\nFrom: me@example.com\r\n\r\nOld')
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'test', passwordEnv: 'PASS' }, imap: { host: '127.0.0.1', port: fixture.port, username: 'test', passwordEnv: 'PASS', security: 'plain', pollIntervalMs: 100 }, retry: { initialMs: 100, maxMs: 200 } })
  const store = new Store(':memory:', config.recipients)
  const abort = new AbortController()
  let state = ''
  const runner = startImap(config, 'test', store, abort.signal, value => { state = value })
  try {
    await until(async () => state === 'connected', 5000)
    expect(store.pendingMail()).toEqual([])
    fixture.append('Message-ID: <new@example.com>\r\nFrom: me@example.com\r\n\r\nContinue')
    await until(async () => store.pendingMail().length === 1, 5000)
    fixture.reset()
    await until(async () => store.pendingMail().length === 2, 5000)
    // New mail is not duplicated on rescan; the formerly baseline historical
    // message is stored on reset but cannot route without an outbound thread.
    expect(store.pendingMail().length).toBe(2)
    expect(fixture.commands.some(command => command.includes('UID FETCH'))).toBe(true)
  } catch (error) { console.log('IMAP fixture commands:', fixture.commands); throw error }
  finally { abort.abort(); await runner; await fixture.close(); store.close() }
}, 15000)
