import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parse } from 'jsonc-parser'
import { pathToFileURL } from 'node:url'
import { install } from '../../src/worker/install'
import { loadConfig } from '../../src/core/config'

const mail = (stateDirectory: string) => ({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' }, worker: { stateDirectory } })
test('default installation preserves the effective plugins split across global config files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'email-global-'))
  const previous = process.env.XDG_CONFIG_HOME
  try {
    process.env.XDG_CONFIG_HOME = root
    const global = join(root, 'opencode'); await mkdir(global)
    await writeFile(join(global, 'config.json'), '{"plugin":["legacy-plugin"]}')
    await writeFile(join(global, 'opencode.json'), '{"plugin":[["existing-plugin",{"setting":true}]]}')
    await writeFile(join(global, 'opencode.jsonc'), '{// retained\n"model":"provider/model"}')
    install({ configPath: join(root, 'mail/config.json'), stateDirectory: join(root, 'state') })
    const config = parse(await readFile(join(global, 'opencode.jsonc'), 'utf8'))
    expect(config.plugin[0]).toEqual(['existing-plugin', { setting: true }])
    expect(config.plugin).toHaveLength(2)
    expect(config.model).toBe('provider/model')
    expect(await readFile(join(global, 'opencode.json'), 'utf8')).toBe('{"plugin":[["existing-plugin",{"setting":true}]]}')
    // When no later array exists, legacy plugins must survive materialization.
    await writeFile(join(global, 'opencode.json'), '{"model":"provider/model"}')
    await writeFile(join(global, 'opencode.jsonc'), '{}')
    install({ configPath: join(root, 'other-mail/config.json'), stateDirectory: join(root, 'other-state') })
    expect(parse(await readFile(join(global, 'opencode.jsonc'), 'utf8')).plugin[0]).toBe('legacy-plugin')
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})
test('installer stores existing relative state paths as absolute so project changes do not fork state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'email-relative-state-'))
  const previous = process.cwd()
  await mkdir(join(root, 'other'))
  try {
    process.chdir(root)
    const configPath = join(root, 'config.json')
    await writeFile(configPath, JSON.stringify(mail('./queues')))
    install({ configPath, opencodeConfigPath: join(root, 'opencode.json') })
    process.chdir(join(root, 'other'))
    expect(loadConfig(configPath).worker.stateDirectory).toBe(join(root, 'queues'))
  } finally { process.chdir(previous); await rm(root, { recursive: true, force: true }) }
})
test('installer updates symlink targets without replacing the persistent configuration links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'email-links-'))
  await mkdir(join(root, 'persistent'))
  const mailTarget = join(root, 'persistent/mail.json'); const opencodeTarget = join(root, 'persistent/opencode.jsonc')
  const configPath = join(root, 'mail.json'); const opencodeConfigPath = join(root, 'opencode.jsonc')
  await writeFile(mailTarget, JSON.stringify(mail(join(root, 'state')))); await writeFile(opencodeTarget, '{"plugin":["other"]}')
  await symlink(mailTarget, configPath); await symlink(opencodeTarget, opencodeConfigPath)
  try {
    install({ configPath, opencodeConfigPath })
    expect((await lstat(configPath)).isSymbolicLink()).toBe(true)
    expect((await lstat(opencodeConfigPath)).isSymbolicLink()).toBe(true)
    expect(JSON.parse(await readFile(mailTarget, 'utf8')).worker.autoStart).toBe(true)
    expect(parse(await readFile(opencodeTarget, 'utf8')).plugin).toHaveLength(2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('relocated package registration replaces a managed prior entry and survives removing the old package', async () => {
  const root = await mkdtemp(join(tmpdir(), 'email-relocation-'))
  const configPath = join(root, 'mail.json'); const opencodeConfigPath = join(root, 'opencode.json')
  const oldPackage = join(root, 'old-package'); await mkdir(join(oldPackage, 'dist'), { recursive: true })
  await writeFile(join(oldPackage, 'package.json'), '{"name":"opencode-email-sync"}')
  const oldEntry = pathToFileURL(join(oldPackage, 'dist/index.js')).href
  await writeFile(configPath, JSON.stringify(mail(join(root, 'state'))))
  await writeFile(opencodeConfigPath, JSON.stringify({ plugin: [[oldEntry, { configPath }], ['unrelated', { configPath }]] }))
  try {
    install({ configPath, opencodeConfigPath })
    let plugins = parse(await readFile(opencodeConfigPath, 'utf8')).plugin
    expect(plugins).toHaveLength(2)
    expect(plugins[0][0]).not.toBe(oldEntry)
    expect(plugins[1]).toEqual(['unrelated', { configPath }])
    // A recorded installer-owned entry remains recognizable after deletion.
    await writeFile(opencodeConfigPath, JSON.stringify({ plugin: [[oldEntry, { configPath }], ['unrelated', { configPath }]] }))
    const manifestPath = join(root, '.email-sync-installation.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.pluginEntry = oldEntry
    await writeFile(manifestPath, JSON.stringify(manifest))
    await rm(oldPackage, { recursive: true, force: true })
    install({ configPath, opencodeConfigPath })
    plugins = parse(await readFile(opencodeConfigPath, 'utf8')).plugin
    expect(plugins).toHaveLength(2)
    expect(plugins[0][0]).not.toBe(oldEntry)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('unmanaged launcher conflict rejects installation before changing mail, credentials, or state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'email-install-conflict-'))
  const configPath = join(root, 'config.json'); const opencodeConfigPath = join(root, 'opencode.json')
  const original = JSON.stringify(mail(join(root, 'state')))
  await writeFile(configPath, original); await writeFile(opencodeConfigPath, '{}')
  await mkdir(join(root, 'bin')); await writeFile(join(root, 'bin/opencode-email-sync'), '# operator command\n')
  try {
    expect(() => install({ configPath, opencodeConfigPath })).toThrow('unmanaged')
    expect(await readFile(configPath, 'utf8')).toBe(original)
    expect(await Bun.file(join(root, 'worker.env')).exists()).toBe(false)
    expect(await Bun.file(join(root, 'state/token')).exists()).toBe(false)
    expect(await readFile(opencodeConfigPath, 'utf8')).toBe('{}')
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('configuration aliases through symlinked directories cannot select the same file for both configs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'email-alias-conflict-'))
  const persistent = join(root, 'persistent'); await mkdir(persistent)
  const original = JSON.stringify(mail(join(root, 'state')))
  await writeFile(join(persistent, 'config.json'), original)
  await symlink(persistent, join(root, 'first')); await symlink(persistent, join(root, 'second'))
  try {
    expect(() => install({ configPath: join(root, 'first/config.json'), opencodeConfigPath: join(root, 'second/config.json') })).toThrow('different files')
    expect(await readFile(join(persistent, 'config.json'), 'utf8')).toBe(original)
    expect(() => install({ configPath: join(root, 'first/new/config.json'), opencodeConfigPath: join(root, 'second/new/config.json'), stateDirectory: join(root, 'new-state') })).toThrow('different files')
  } finally { await rm(root, { recursive: true, force: true }) }
})
