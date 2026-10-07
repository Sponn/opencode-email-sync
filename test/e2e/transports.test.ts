import { expect, test } from 'bun:test'
import { SMTPServer } from 'smtp-server'
import { simpleParser } from 'mailparser'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeState } from '../../src/worker/files'
import { WorkerClient } from '../../src/worker/server'
import { imapFixture } from '../fixtures/imap-server'
import { disposableOpenCode, until } from '../fixtures/opencode'

test('worker process sends actual SMTP answers and receives actual IMAP replies and identical toggles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-transport-e2e-'))
  const incoming = await imapFixture({ idle: true })
  const outgoing: string[] = []
  const smtp = new SMTPServer({ authOptional: true, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], onAuth(_auth, _session, callback) { callback(null, { user: 'test' }) }, onData(stream, _session, callback) { let text = ''; stream.on('data', data => text += data); stream.on('end', () => { outgoing.push(text); callback() }) } })
  await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve))
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = holder.port!; holder.stop(true)
  const state = initializeState(directory)
  const worker = new WorkerClient(port, state.token)
  let app: Awaited<ReturnType<typeof disposableOpenCode>> | undefined
  let process: ReturnType<typeof Bun.spawn> | undefined
  try {
    const configPath = join(directory, 'config.json')
    app = await disposableOpenCode(configPath, port, directory, {
      smtp: { host: '127.0.0.1', port: (smtp.server.address() as { port: number }).port, username: 'test', passwordEnv: 'PASS', security: 'plain' },
      imap: { host: '127.0.0.1', port: incoming.port, username: 'test', passwordEnv: 'PASS', security: 'plain', pollIntervalMs: 100 },
    })
    process = Bun.spawn([globalThis.process.execPath, globalThis.process.env.EMAIL_SYNC_BUILT_TEST ? 'dist/cli.js' : 'src/cli.ts', 'start', '--config', configPath], { env: { ...globalThis.process.env, PASS: 'test' }, stdout: 'ignore', stderr: 'inherit' })
    await until(async () => { try { return (await worker.request<any>('status')).mail.imap === 'connected' } catch { return false } })
    const session = await app.request(app.projectA, '/session', { title: 'Mail transport round trip' })
    await app.request(app.projectA, `/session/${session.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Make a change' }] })
    await until(async () => outgoing.length === 2)
    const notification = (await Promise.all(outgoing.map(raw => simpleParser(raw)))).find(mail => (Array.isArray(mail.to) ? mail.to[0] : mail.to)?.value[0].address === 'me@example.com')!
    expect(notification.subject).toContain(`[${session.id}]`)
    expect(notification.html).toContain('<pre')
    const route = { instanceId: state.instanceId, projectId: session.projectID, directory: app.projectA, sessionId: session.id }
    const reply = (id: string, text: string, sender = 'me@example.com') => incoming.append(`From: ${sender}\r\nTo: bot@example.com\r\nMessage-ID: <${id}@example.com>\r\nIn-Reply-To: ${notification.messageId}\r\nContent-Type: text/plain\r\n\r\n${text}`)
    reply('off', '!opencode-email-sync session off')
    await until(async () => !(await worker.request<any>('policy', { route })).enabled)
    const calls = app.modelCalls()
    reply('ignored', 'Do not execute this while off')
    reply('evil', '!opencode-email-sync session on', 'evil@example.com')
    reply('status', '!opencode-email-sync session status')
    await until(async () => outgoing.length >= 4)
    expect(app.modelCalls()).toBe(calls)
    expect((await worker.request<any>('policy', { route })).enabled).toBe(false)
    reply('on', '!opencode-email-sync session on')
    await until(async () => (await worker.request<any>('policy', { route })).enabled)
    reply('continue', 'Continue via the mail transport')
    const current = app
    await until(async () => (await current.request<any[]>(current.projectA, `/session/${session.id}/message`)).some(message => message.parts.some((part: any) => part.text === 'Continue via the mail transport')))
    await until(async () => outgoing.length >= 7)
    expect(app.modelCalls()).toBeGreaterThan(calls)
  } catch (error) { console.log('Worker status:', await worker.request('status').catch(() => 'unavailable')); console.log('IMAP commands:', incoming.commands); throw error }
  finally {
    process?.kill('SIGTERM')
    if (process) { const timeout = setTimeout(() => process?.kill('SIGKILL'), 10000); await process.exited; clearTimeout(timeout) }
    await app?.close(); await incoming.close(); await new Promise<void>(resolve => smtp.close(resolve)); await rm(directory, { recursive: true, force: true })
  }
}, 90000)
