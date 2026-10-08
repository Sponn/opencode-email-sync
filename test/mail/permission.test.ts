import { expect, test } from 'bun:test'
import { permissionText } from '../../src/mail/permission'
import { renderMail } from '../../src/mail/render'
import { validateConfig } from '../../src/core/config'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
const request = { id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['git push *'], always: ['git push *'], metadata: { command: 'git push origin main' } }
test('permission email visibly includes all available reply commands and broader approval scope', () => {
  const text = permissionText(request)
  for (const action of ['once', 'reject', 'always']) expect(text).toContain(`!opencode-email-sync permission ${action}`)
  expect(text).toContain('git push origin main')
  expect(text).toContain('per_a')
  expect(text).toContain('matching actions')
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' } })
  const rendered = renderMail({ id: 'd', route, text, recipient: 'me@example.com', project: 'Project', title: 'Session', messageId: '<permission@local>', permissionKey: 'permission-a', control: false, attempts: 0 }, config)
  expect(rendered.subject).toContain('Permission required')
  expect(rendered.subject.endsWith('[ses_a]')).toBe(true)
  for (const action of ['once', 'reject', 'always']) {
    expect(rendered.text).toContain(`!opencode-email-sync permission ${action}`)
    expect(rendered.html).toContain(`!opencode-email-sync permission ${action}`)
  }
  expect(rendered.text).not.toContain('Reply above the quoted message to continue this session')
})
