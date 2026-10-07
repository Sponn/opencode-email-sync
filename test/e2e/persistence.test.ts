import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, readFile, writeFile, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { imapFixture } from '../fixtures/imap-server'
import { until } from '../fixtures/opencode'
import { WorkerClient } from '../../src/worker/server'
import { readState } from '../../src/worker/files'

test('installed plugin recreates worker and CLI in fresh OpenCode processes while preserving session policy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'email-persistent-e2e-'))
  const project = join(home, 'project'); await mkdir(project)
  const mailDirectory = join(home, 'config/email'); await mkdir(mailDirectory, { recursive: true })
  const configPath = join(mailDirectory, 'config.json')
  const opencodeConfigPath = join(home, 'config/opencode/opencode.jsonc')
  const stateDirectory = join(home, 'state/email')
  const imap = await imapFixture()
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const workerPort = holder.port!; holder.stop(true)
  await writeFile(configPath, JSON.stringify({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: '127.0.0.1', port: 1, username: 'test', passwordEnv: 'PERSISTENT_TEST_PASSWORD', security: 'plain' }, imap: { host: '127.0.0.1', port: imap.port, username: 'test', passwordEnv: 'PERSISTENT_TEST_PASSWORD', security: 'plain', pollIntervalMs: 100 }, worker: { autoStart: true, port: workerPort, stateDirectory, envFile: 'worker.env', restartDelayMs: 100 } }))
  await writeFile(join(mailDirectory, 'worker.env'), 'PERSISTENT_TEST_PASSWORD="fixture-only"\n')
  const cliPath = resolve(process.env.EMAIL_SYNC_BUILT_TEST ? 'dist/cli.js' : 'src/cli.ts')
  const installer = Bun.spawn([process.execPath, cliPath, 'install', '--config', configPath, '--opencode-config', opencodeConfigPath], { stdout: 'pipe', stderr: 'pipe' })
  expect(await installer.exited).toBe(0)
  const identity = readState(stateDirectory)
  const worker = new WorkerClient(workerPort, identity.token)
  let app: ReturnType<typeof Bun.spawn> | undefined
  async function stopWorker() {
    try {
      const record = JSON.parse(await readFile(join(stateDirectory, 'supervisor.json'), 'utf8'))
      // Simulate losing every process in a recreated container, keeping only
      // the mounted package/runtime/configuration/state directories.
      try { process.kill(record.pid, 'SIGKILL') } catch {}
      if (record.workerPid) { try { process.kill(record.workerPid, 'SIGKILL') } catch {} }
    } catch {}
    await until(async () => { try { await worker.request('status', undefined, AbortSignal.timeout(500)); return false } catch { return true } })
  }
  async function startInstance() {
    const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = holder.port!; holder.stop(true)
    app = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: project, stdout: 'ignore', stderr: 'ignore', env: {
        ...process.env, HOME: home, PATH: '/usr/local/bin:/usr/bin:/bin', XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'share'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'),
        OPENCODE_CONFIG_DIR: join(home, 'config/opencode'), OPENCODE_CONFIG: '', OPENCODE_SERVER_PASSWORD: '',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'probe/probe', enabled_providers: ['probe'], provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'test-only' }, models: { probe: { name: 'Probe', limit: { context: 10000, output: 1000 } } } } } }),
      },
    })
    const base = `http://127.0.0.1:${port}`
    await until(async () => { try { return (await fetch(`${base}/global/health`, { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 30000)
    expect((await fetch(`${base}/session`, { signal: AbortSignal.timeout(20000) })).ok).toBe(true)
    await until(async () => { try { const status = await worker.request<any>('status'); return status.adapters > 0 && status.mail.imap === 'connected' } catch { return false } })
    return base
  }
  try {
    const first = await startInstance()
    const session = await (await fetch(`${first}/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Persist this session' }) })).json() as any
    const shell = await fetch(`${first}/session/${session.id}/shell`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'build', command: 'opencode-email-sync session off' }) })
    expect(shell.ok).toBe(true)
    expect((await shell.json() as any).parts[0].state.output).toContain(`Email sync is OFF for ${session.id}`)
    app!.kill('SIGKILL'); await app!.exited; app = undefined
    await stopWorker()
    await unlink(join(mailDirectory, 'bin/opencode-email-sync'))
    const second = await startInstance()
    expect(readState(stateDirectory)).toEqual(identity)
    expect(await Bun.file(join(mailDirectory, 'bin/opencode-email-sync')).exists()).toBe(true)
    const status = await fetch(`${second}/session/${session.id}/shell`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'build', command: 'opencode-email-sync session status' }) })
    expect(status.ok).toBe(true)
    expect((await status.json() as any).parts[0].state.output).toContain(`Email sync is OFF for ${session.id}`)
  } finally {
    if (app) { app.kill('SIGKILL'); await app.exited }
    await stopWorker(); await imap.close(); await rm(home, { recursive: true, force: true })
  }
}, 90000)
