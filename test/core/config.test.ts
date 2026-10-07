import { expect, test } from 'bun:test'
import { validateConfig, resolveCredentials } from '../../src/core/config'
const input = { account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'smtp.example.com', port: 465, username: 'bot', passwordEnv: 'MAIL_PASSWORD' }, imap: { host: 'imap.example.com', port: 993, username: 'bot', passwordEnv: 'MAIL_PASSWORD' } }
test('configuration validates recipients and TLS settings and keeps credentials separate', () => {
  const config = validateConfig(input)
  expect(config.smtp.security).toBe('tls')
  expect(config.imap.mailbox).toBe('INBOX')
  expect(() => validateConfig({ ...input, recipients: [] })).toThrow()
  expect(() => validateConfig({ ...input, smtp: { ...input.smtp, port: -1 } })).toThrow()
  expect(() => resolveCredentials(config, {})).toThrow('MAIL_PASSWORD')
  expect(resolveCredentials(config, { MAIL_PASSWORD: 'test' })).toEqual({ smtp: 'test', imap: 'test' })
  expect(JSON.stringify(config)).not.toContain('"test"')
})
