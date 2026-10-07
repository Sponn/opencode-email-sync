import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig } from '../../src/core/config'
import { ensureWorker } from '../../src/worker/bootstrap'
import { readState } from '../../src/worker/files'
import { WorkerClient } from '../../src/worker/server'
import { until } from '../fixtures/opencode'
test('autostart waits for credentials, restores CLI, restarts crashed workers, and reloads passwords', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-autostart-'))
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = holder.port!; holder.stop(true)
  const configPath = join(directory, 'config.json'); const envFile = join(directory, 'worker.env')
  await writeFile(configPath, JSON.stringify({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'AUTOSTART_TEST_PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'AUTOSTART_TEST_PASS' }, worker: { port, stateDirectory: join(directory, 'state'), autoStart: true, envFile, restartDelayMs: 100 } }))
  await writeFile(envFile, 'AUTOSTART_TEST_PASS=""\n')
  const runtime = { bunPath: process.execPath, cliPath: resolve('test/fixtures/supervised-cli.ts') }
  const config = loadConfig(configPath)
  let supervisor: Awaited<ReturnType<typeof ensureWorker>>
  try {
    supervisor = await ensureWorker(configPath, runtime)
    const worker = new WorkerClient(port, readState(config.worker.stateDirectory).token)
    await until(async () => { try { return (await readFile(join(config.worker.stateDirectory, 'worker.log'), 'utf8')).includes('Waiting for') } catch { return false } })
    await writeFile(envFile, 'AUTOSTART_TEST_PASS="first-test-value"\n')
    let first: { pid: number; credentialVersion: string } | undefined
    await until(async () => { try { first = await worker.request('status'); return !!first } catch { return false } })
    expect(first!.credentialVersion).toBe('first')
    await unlink(join(config.worker.binDirectory, 'opencode-email-sync'))
    await ensureWorker(configPath, runtime)
    expect(await Bun.file(join(config.worker.binDirectory, 'opencode-email-sync')).exists()).toBe(true)
    await writeFile(envFile, 'AUTOSTART_TEST_PASS="rotated-test-value"\n')
    process.kill(first!.pid, 'SIGKILL')
    let second: { pid: number; credentialVersion: string } | undefined
    await until(async () => { try { second = await worker.request('status'); return !!second && second.pid !== first!.pid } catch { return false } })
    expect(second!.credentialVersion).toBe('rotated')
    const duplicate = Bun.spawn([runtime.bunPath, runtime.cliPath, 'supervise', '--config', configPath], { stdout: 'ignore', stderr: 'ignore' })
    expect(await duplicate.exited).not.toBe(0)
    expect((await worker.request<{ pid: number }>('status')).pid).toBe(second!.pid)
  } finally {
    if (supervisor!) { supervisor.kill('SIGTERM'); await supervisor.exited }
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
