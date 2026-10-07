import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeState } from '../../src/worker/files'
import { Store } from '../../src/state/database'
import { startControlServer } from '../../src/worker/server'
test('session CLI uses shell-injected route and prints worker confirmation without mail credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-cli-'))
  const state = initializeState(directory)
  const store = new Store(':memory:', ['me@example.com'])
  const server = startControlServer(store, state.token, 0)
  const route = { instanceId: state.instanceId, projectId: 'p', directory: '/project', sessionId: 'ses_a' }
  store.registerSession(route, 'Project', 'Session')
  const path = join(directory, 'config.json')
  await writeFile(path, JSON.stringify({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'SECRET_NOT_SET' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'SECRET_NOT_SET' }, worker: { port: server.port, stateDirectory: directory } }))
  try {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', 'session', 'off'], { env: { ...process.env, OPENCODE_EMAIL_ROUTE: JSON.stringify(route), OPENCODE_EMAIL_CONFIG: path }, stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain('Email sync is OFF for ses_a')
    expect(store.policy(route)).toBe(false)
    const arbitrary = Bun.spawn([process.execPath, 'src/cli.ts', 'session', 'delete'], { env: { ...process.env, OPENCODE_EMAIL_ROUTE: JSON.stringify(route), OPENCODE_EMAIL_CONFIG: path }, stdout: 'pipe', stderr: 'pipe' })
    expect(await arbitrary.exited).toBe(1)
  } finally { server.stop(true); store.close(); await rm(directory, { recursive: true, force: true }) }
})
