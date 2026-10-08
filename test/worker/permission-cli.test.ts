import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/state/database'
import { initializeState } from '../../src/worker/files'
import { startControlServer } from '../../src/worker/server'
test('permission CLI uses session context and reports actual OpenCode acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-permission-cli-'))
  const state = initializeState(directory); const store = new Store(':memory:', [])
  const server = startControlServer(store, state.token, 0)
  const configPath = join(directory, 'config.json')
  const route = { instanceId: state.instanceId, projectId: 'p', directory: '/project', sessionId: 'ses_a' }
  await writeFile(configPath, JSON.stringify({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' }, worker: { port: server.port, stateDirectory: directory } }))
  store.registerSession(route, 'P', 'S')
  store.permissions.sync(route, [{ id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['git push'], always: ['git push'], metadata: {} }])
  const child = Bun.spawn([process.execPath, 'src/cli.ts', 'permission', 'once', 'per_a'], { env: { ...process.env, OPENCODE_EMAIL_CONFIG: configPath, OPENCODE_EMAIL_ROUTE: JSON.stringify(route) }, stdout: 'pipe', stderr: 'pipe' })
  try {
    let job: ReturnType<typeof store.permissions.claim>
    const start = Date.now()
    while (!(job = store.permissions.claim(route, 'adapter'))) {
      if (Date.now() - start > 3000) throw new Error(`Permission CLI failed to queue: ${await new Response(child.stderr).text()}`)
      await Bun.sleep(20)
    }
    store.permissions.begin(job.id, 'adapter'); store.permissions.ack(job.id, 'adapter', 'accepted')
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain('OpenCode accepted')
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; server.stop(true); store.close(); await rm(directory, { recursive: true, force: true }) }
}, 10000)
