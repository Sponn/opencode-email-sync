import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeState } from '../../src/worker/files'
import { createAdapter } from '../../src/opencode/adapter'
import type { PluginInput } from '@opencode-ai/plugin'
test('a mail-worker outage never blocks ordinary OpenCode shell execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-outage-'))
  initializeState(directory)
  const configPath = join(directory, 'config.json')
  await writeFile(configPath, JSON.stringify({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' }, worker: { port: 1, stateDirectory: directory } }))
  const session = { id: 'ses_a', directory: '/project', title: 'S' }
  const input = { directory: '/project', worktree: '/project', project: { id: 'p' }, client: { session: { get: async () => ({ data: session }), messages: async () => ({ data: [] }) }, app: { log: async () => ({ data: true }) } } } as unknown as PluginInput
  const hooks = createAdapter(input, configPath)
  try {
    const output = { env: {} as Record<string, string> }
    await hooks['shell.env']!({ cwd: '/project', sessionID: 'ses_a' }, output)
    expect(output.env.OPENCODE_EMAIL_CONFIG).toBe(configPath)
    expect(JSON.parse(output.env.OPENCODE_EMAIL_ROUTE).sessionId).toBe('ses_a')
  } finally { await hooks.dispose!(); await rm(directory, { recursive: true, force: true }) }
})
