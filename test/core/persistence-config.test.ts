import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, validateConfig } from '../../src/core/config'
const input = { account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'SMTP_PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'IMAP_PASS' } }
test('autostart is opt-in and relative worker paths resolve against the configuration file', async () => {
  expect(validateConfig(input).worker.autoStart).toBe(false)
  const directory = await mkdtemp(join(tmpdir(), 'email-config-'))
  try {
    const path = join(directory, 'config.json')
    await writeFile(path, JSON.stringify({ ...input, worker: { autoStart: true, envFile: 'private/worker.env', bunPath: './runtime/bun', binDirectory: './bin' } }))
    const config = loadConfig(path)
    expect(config.worker.autoStart).toBe(true)
    expect(config.worker.envFile).toBe(join(directory, 'private/worker.env'))
    expect(config.worker.bunPath).toBe(join(directory, 'runtime/bun'))
    expect(config.worker.binDirectory).toBe(join(directory, 'bin'))
    expect(() => validateConfig({ ...input, worker: { restartDelayMs: 0 } })).toThrow()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
