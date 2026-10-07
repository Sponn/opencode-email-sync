import { expect, test } from 'bun:test'
import { renderMail } from '../../src/mail/render'
import { parseIncoming, authorize, extractReply } from '../../src/mail/parse'
import { validateConfig } from '../../src/core/config'
const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' } })
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
const thread = { route, recipient: 'me@example.com', project: 'Project', title: 'Session', messageId: '<abc@opencode.local>' }
test('answer mail preserves code and rejects executable markup', () => {
  const result = renderMail({ id: 'd', route, recipient: 'me@example.com', text: '# Done\n\n```ts\nconst x = 1\n```\n<script>alert(1)</script><img src="https://tracker">', project: 'Project\r\nBcc: evil', title: 'Session', messageId: '<abc@opencode.local>', control: false, attempts: 0 }, config)
  expect(result.subject.endsWith('[ses_a]')).toBe(true)
  expect(result.subject).not.toContain('\n')
  expect(result.html).toContain('<pre')
  expect(result.html).not.toContain('<script')
  expect(result.html).not.toContain('<img')
  expect(result.text).toContain('!opencode-email-sync session off')
})
const raw = (from: string, body: string, headers = '') => Buffer.from(`From: ${from}\r\nTo: bot@example.com\r\nMessage-ID: <reply@example.com>\r\nIn-Reply-To: <abc@opencode.local>\r\n${headers}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}`)
test('authorized email extracts new text and ignores quoted history', async () => {
  const mail = await parseIncoming(raw('me@example.com', 'Continue\r\n\r\nOn Tuesday, Bot wrote:\r\n> Done'), 100000)
  expect(authorize(mail, config, thread)).toBe(true)
  expect(extractReply(mail)).toEqual({ kind: 'text', text: 'Continue' })
  expect(authorize(await parseIncoming(raw('"me@example.com" <evil@example.com>', 'off'), 100000), config, thread)).toBe(false)
  expect(authorize(await parseIncoming(raw('me@example.com, evil@example.com', 'off'), 100000), config, thread)).toBe(false)
  expect(authorize(await parseIncoming(raw('me@example.com', 'off', 'Auto-Submitted: auto-replied\r\n'), 100000), config, thread)).toBe(false)
  expect(() => parseIncoming(Buffer.alloc(100001), 100000)).toThrow()
})
test('HTML-only replies and explicit delimiters keep authored text', async () => {
  const html = Buffer.from('From: me@example.com\r\nContent-Type: text/html\r\n\r\n<div>Proceed</div><blockquote>Old reply</blockquote>')
  expect(extractReply(await parseIncoming(html, 100000))).toEqual({ kind: 'text', text: 'Proceed' })
  expect(extractReply(await parseIncoming(raw('me@example.com', 'Use this\n--- end reply ---\nOld text'), 100000))).toEqual({ kind: 'text', text: 'Use this' })
})
