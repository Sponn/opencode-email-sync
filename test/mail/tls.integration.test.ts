import { expect, test } from 'bun:test'
import { SMTPServer } from 'smtp-server'
import { ImapFlow } from 'imapflow'
import { createSmtp } from '../../src/mail/smtp'
import { imapOptions, startImap } from '../../src/mail/imap'
import { Store } from '../../src/state/database'
import { validateConfig } from '../../src/core/config'
import { testCertificate } from '../fixtures/tls'
import { imapFixture } from '../fixtures/imap-server'
import { until } from '../fixtures/opencode'
test('SMTP implicit TLS and required STARTTLS validate configured CA certificates', async () => {
  const certificate = await testCertificate()
  let count = 0
  const options = { key: certificate.key, cert: certificate.cert, onAuth(_auth: unknown, _session: unknown, callback: (error: null, result: { user: string }) => void) { callback(null, { user: 'test' }) }, onData(stream: NodeJS.ReadableStream, _session: unknown, callback: () => void) { stream.on('data', () => {}); stream.on('end', () => { count++; callback() }) } }
  const implicit = new SMTPServer({ ...options, secure: true }); const starttls = new SMTPServer(options)
  implicit.on('error', () => {}); starttls.on('error', () => {})
  await new Promise<void>(resolve => implicit.listen(0, '127.0.0.1', resolve)); await new Promise<void>(resolve => starttls.listen(0, '127.0.0.1', resolve))
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: '127.0.0.1', port: (implicit.server.address() as { port: number }).port, username: 'test', passwordEnv: 'PASS', caFile: certificate.certPath }, imap: { host: 'localhost', port: 993, username: 'test', passwordEnv: 'PASS' } })
  const mail = { from: 'bot@example.com', to: 'me@example.com', text: 'TLS verified' }
  const clients = [createSmtp(config, { smtp: 'test', imap: 'test' }), createSmtp({ ...config, smtp: { ...config.smtp, security: 'starttls', port: (starttls.server.address() as { port: number }).port } }, { smtp: 'test', imap: 'test' }), createSmtp({ ...config, smtp: { ...config.smtp, caFile: undefined } }, { smtp: 'test', imap: 'test' })]
  try {
    expect(await clients[0].send(mail)).toBe('sent'); expect(await clients[1].send(mail)).toBe('sent')
    await expect(clients[2].send(mail)).rejects.toThrow()
    expect(count).toBe(2)
  } finally { for (const client of clients) await client.close(); await new Promise<void>(resolve => implicit.close(resolve)); await new Promise<void>(resolve => starttls.close(resolve)); await certificate.close() }
}, 15000)
test('IMAP implicit TLS uses the configured CA and IDLE receives new mail', async () => {
  const certificate = await testCertificate()
  const fixture = await imapFixture({ tls: certificate, idle: true })
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'test', passwordEnv: 'PASS' }, imap: { host: '127.0.0.1', port: fixture.port, username: 'test', passwordEnv: 'PASS', caFile: certificate.certPath, pollIntervalMs: 1000 } })
  const untrusted = new ImapFlow(imapOptions({ ...config, imap: { ...config.imap, caFile: undefined } }, 'test'))
  untrusted.on('error', () => {})
  await expect(untrusted.connect()).rejects.toThrow()
  untrusted.close()
  const trusted = new ImapFlow(imapOptions(config, 'test'))
  trusted.on('error', error => console.log('Trusted IMAP error:', error.message))
  try { await trusted.connect(); await trusted.logout() } catch (error) { console.log('TLS fixture commands:', fixture.commands); throw error }
  const store = new Store(':memory:', config.recipients)
  const abort = new AbortController()
  const runner = startImap(config, 'test', store, abort.signal, () => {})
  try {
    await until(async () => fixture.commands.some(command => command.includes('IDLE')), 5000)
    fixture.append('Message-ID: <idle@example.com>\r\nFrom: me@example.com\r\n\r\nGo')
    await until(async () => store.pendingMail().length === 1, 5000)
    expect(store.pendingMail()).toHaveLength(1)
  } finally { abort.abort(); await runner; store.close(); await fixture.close(); await certificate.close() }
}, 15000)
