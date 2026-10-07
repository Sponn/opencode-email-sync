import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'jsonc-parser'
import { install } from '../../src/worker/install'
import { loadConfig } from '../../src/core/config'
test('installer is rootless, preserves comments/settings, and does not overwrite credentials or duplicate registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-install-'))
  const configPath = join(directory, 'mail/config.json'); const opencodeConfigPath = join(directory, 'opencode/opencode.jsonc')
  await mkdir(join(directory, 'opencode'))
  await writeFile(opencodeConfigPath, '{\n  // Keep this configuration comment\n  "model": "provider/model",\n  "plugin": [\n    // Keep this plugin comment\n    ["other-plugin", {"custom": true}],\n  ],\n  "server": {"port": 4096},\n}\n')
  try {
    const options = { configPath, opencodeConfigPath, stateDirectory: join(directory, 'state') }
    const result = install(options)
    const first = await readFile(opencodeConfigPath, 'utf8')
    expect(first).toContain('// Keep this configuration comment')
    expect(first).toContain('// Keep this plugin comment')
    const parsed = parse(first)
    expect(parsed.model).toBe('provider/model')
    expect(parsed.server.port).toBe(4096)
    expect(parsed.plugin[0]).toEqual(['other-plugin', { custom: true }])
    expect(parsed.plugin[1][1].configPath).toBe(configPath)
    const config = loadConfig(configPath)
    expect(config.worker.autoStart).toBe(true)
    expect(config.worker.bunPath).toBe(process.execPath)
    expect(result.envFile).toBe(join(directory, 'mail/worker.env'))
    expect((await stat(result.envFile)).mode & 0o777).toBe(0o600)
    const identity = await readFile(join(config.worker.stateDirectory, 'instance-id'), 'utf8')
    await writeFile(result.envFile, 'OPENCODE_MAIL_PASSWORD="existing-test-password"\n')
    install(options)
    expect(await readFile(opencodeConfigPath, 'utf8')).toBe(first)
    expect(await readFile(result.envFile, 'utf8')).toContain('existing-test-password')
    expect(await readFile(join(config.worker.stateDirectory, 'instance-id'), 'utf8')).toBe(identity)
    const cli = Bun.spawn([result.launcher, '--help'], { env: { PATH: '/usr/bin:/bin' }, stdout: 'pipe', stderr: 'pipe' })
    expect(await cli.exited).toBe(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('installer keeps explicitly configured manual startup and rejects malformed OpenCode config before editing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-install-existing-'))
  const configPath = join(directory, 'config.json'); const opencodeConfigPath = join(directory, 'opencode.jsonc')
  const raw = { account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'CUSTOM_PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'CUSTOM_PASS' }, worker: { autoStart: false, stateDirectory: join(directory, 'state') } }
  await writeFile(configPath, JSON.stringify(raw)); await writeFile(opencodeConfigPath, '{broken json')
  try {
    expect(() => install({ configPath, opencodeConfigPath })).toThrow('OpenCode')
    expect(await readFile(configPath, 'utf8')).toBe(JSON.stringify(raw))
    await writeFile(opencodeConfigPath, '{}')
    install({ configPath, opencodeConfigPath })
    expect(loadConfig(configPath).worker.autoStart).toBe(false)
    expect((await readFile(join(directory, 'worker.env'), 'utf8'))).toContain('CUSTOM_PASS=""')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('installer records the state path and an explicit Bun option repairs a relocated runtime', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-install-runtime-'))
  const configPath = join(directory, 'config.json'); const opencodeConfigPath = join(directory, 'opencode.json')
  const previous = process.env.XDG_STATE_HOME
  try {
    process.env.XDG_STATE_HOME = join(directory, 'persistent-state')
    install({ configPath, opencodeConfigPath })
    const raw = JSON.parse(await readFile(configPath, 'utf8'))
    expect(raw.worker.stateDirectory).toBe(join(directory, 'persistent-state/opencode-email-sync'))
    raw.worker.bunPath = join(directory, 'removed/runtime/bun')
    await writeFile(configPath, JSON.stringify(raw))
    install({ configPath, opencodeConfigPath, bunPath: process.execPath })
    expect(loadConfig(configPath).worker.bunPath).toBe(process.execPath)
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
})
