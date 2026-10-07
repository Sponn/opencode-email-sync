import { expect, test } from 'bun:test'
import { ImapFlow } from 'imapflow'
import { imapFixture } from '../fixtures/imap-server'
import { imapOptions } from '../../src/mail/imap'
import { validateConfig } from '../../src/core/config'
test('required IMAP STARTTLS refuses a plaintext-only server before sending credentials', async () => {
  const fixture = await imapFixture()
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'test', passwordEnv: 'PASS' }, imap: { host: '127.0.0.1', port: fixture.port, username: 'test', passwordEnv: 'PASS', security: 'starttls' } })
  const client = new ImapFlow(imapOptions(config, 'test'))
  client.on('error', () => {})
  try { await expect(client.connect()).rejects.toThrow(); expect(fixture.commands.some(command => /AUTHENTICATE|LOGIN/.test(command))).toBe(false) }
  finally { client.close(); await fixture.close() }
})
