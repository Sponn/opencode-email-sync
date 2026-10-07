import { expect, test } from 'bun:test'
import { authorize, parseIncoming } from '../../src/mail/parse'
import { validateConfig } from '../../src/core/config'
const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' }, senderAuthentication: { trustedAuthservIds: ['mx.example.net'] } })
const thread = { route: { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }, recipient: 'me@example.com', project: 'P', title: 'S', messageId: '<sent@opencode.local>' }
test('trusted receiving-server DMARC must pass for the actual sender and forged lower headers do not override failure', async () => {
  const parse = async (auth: string) => parseIncoming(Buffer.from(`${auth}\r\nFrom: me@example.com\r\nContent-Type: text/plain\r\n\r\nProceed`), 100000)
  expect(authorize(await parse('Authentication-Results: mx.example.net; dmarc=pass header.from=example.com'), config, thread)).toBe(true)
  expect(authorize(await parse('Authentication-Results: evil.example; dmarc=pass header.from=example.com'), config, thread)).toBe(false)
  expect(authorize(await parse('Authentication-Results: mx.example.net; dmarc=pass header.from=evil.example'), config, thread)).toBe(false)
  expect(authorize(await parse('Authentication-Results: mx.example.net; dmarc=fail header.from=example.com\r\nAuthentication-Results: mx.example.net; dmarc=pass header.from=example.com'), config, thread)).toBe(false)
})
