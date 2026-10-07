import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { createSmtp } from '../../src/mail/smtp'
import { validateConfig } from '../../src/core/config'
test('SMTP server acceptance followed by lost acknowledgment is held as uncertain', async () => {
  let accepted = false
  const server = createServer(socket => {
    socket.write('220 local fixture\r\n'); let buffer = '', data = false
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk.toString()
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 2)
        if (data) { if (line === '.') { accepted = true; socket.destroy() }; continue }
        if (/^EHLO/.test(line)) socket.write('250-fixture\r\n250 AUTH PLAIN LOGIN\r\n')
        else if (/^AUTH/.test(line)) socket.write('235 accepted\r\n')
        else if (line === 'DATA') { data = true; socket.write('354 continue\r\n') }
        else socket.write('250 accepted\r\n')
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: '127.0.0.1', port: (server.address() as { port: number }).port, username: 'test', passwordEnv: 'PASS', security: 'plain' }, imap: { host: 'localhost', port: 993, username: 'test', passwordEnv: 'PASS' } })
  const sender = createSmtp(config, { smtp: 'test', imap: 'test' })
  try { expect(await sender.send({ from: 'bot@example.com', to: 'me@example.com', text: 'Accepted message' })).toBe('uncertain'); expect(accepted).toBe(true) }
  finally { await sender.close(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
