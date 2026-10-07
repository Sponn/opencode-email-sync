import { expect, test } from 'bun:test'
import { SMTPServer } from 'smtp-server'
import { createSmtp } from '../../src/mail/smtp'
import { validateConfig } from '../../src/core/config'
test('SMTP sends through a real local server and does not downgrade required STARTTLS', async () => {
  const received: string[] = []
  const server = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], onAuth(_auth, _session, callback) { callback(null, { user: 'test' }) }, onData(stream, _session, callback) { let data = ''; stream.on('data', chunk => data += chunk); stream.on('end', () => { received.push(data); callback() }) } })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.server.address() as { port: number }).port
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: '127.0.0.1', port, username: 'test', passwordEnv: 'PASS', security: 'plain' }, imap: { host: 'localhost', port: 993, username: 'test', passwordEnv: 'PASS' } })
  const sender = createSmtp(config, { smtp: 'test', imap: 'test' })
  try {
    const mail = { from: 'bot@example.com', to: 'me@example.com', subject: '[Project] Test [ses_a]', text: 'Hello', html: '<p>Hello</p>', messageId: '<smtp-test@opencode.local>' }
    expect(await sender.send(mail)).toBe('sent')
    expect(received[0]).toContain('smtp-test@opencode.local')
    const required = createSmtp({ ...config, smtp: { ...config.smtp, security: 'starttls' } }, { smtp: 'test', imap: 'test' })
    await expect(required.send(mail)).rejects.toThrow()
    await required.close()
    expect(received.length).toBe(1)
  } finally { await sender.close(); await new Promise<void>(resolve => server.close(resolve)) }
}, 10000)
