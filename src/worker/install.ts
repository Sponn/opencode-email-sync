import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { modify, applyEdits } from 'jsonc-parser'
import { defaultConfigPath, validateConfig } from '../core/config'
import { initializeState } from './files'
import { installLauncher, preflightLauncher, runtimePaths, pluginEntry } from './runtime'
import { targetPath, atomicText, preflightFile, preflightDirectory } from './install-files'
import { parseOpenCode, inheritedPlugins, readInstallationRecord, ownedRegistration } from './install-config'

export interface InstallOptions { configPath?: string; opencodeConfigPath?: string; stateDirectory?: string; bunPath?: string }
export interface InstallResult { configPath: string; envFile: string; opencodeConfigPath: string; launcher: string }
export function install(options: InstallOptions = {}): InstallResult {
  const configPath = resolve(options.configPath || defaultConfigPath())
  const opencodeDirectory = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  const opencodeConfigPath = resolve(options.opencodeConfigPath || (existsSync(join(opencodeDirectory, 'opencode.jsonc')) ? join(opencodeDirectory, 'opencode.jsonc') : join(opencodeDirectory, 'opencode.json')))
  const original = existsSync(opencodeConfigPath) ? readFileSync(opencodeConfigPath, 'utf8') : '{}\n'
  const opencode = parseOpenCode(original)
  const connection = { host: 'smtp.example.com', port: 465, username: 'opencode@example.com', passwordEnv: 'OPENCODE_MAIL_PASSWORD', security: 'tls', verifyCertificate: true }
  const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {
    account: { address: 'opencode@example.com', displayName: 'OpenCode' }, recipients: ['you@example.com'],
    smtp: connection, imap: { ...connection, host: 'imap.example.com', port: 993, mailbox: 'INBOX' },
  }
  raw.worker ||= {}
  raw.worker.autoStart ??= true
  raw.worker.envFile ??= 'worker.env'
  if (options.bunPath) raw.worker.bunPath = options.bunPath
  else raw.worker.bunPath ??= process.execPath
  if (options.stateDirectory) raw.worker.stateDirectory = resolve(options.stateDirectory)
  const config = validateConfig(raw, configPath)
  raw.worker.stateDirectory = config.worker.stateDirectory
  const runtime = runtimePaths(config)
  const entry = pathToFileURL(pluginEntry(runtime.cliPath)).href
  const registration = [entry, { configPath }]
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: original.includes('\r\n') ? '\r\n' : '\n' }
  const edit = (text: string, path: (string | number)[], value: unknown) => applyEdits(text, modify(text, path, value, { formattingOptions }))
  let updated = original
  if (!opencode.$schema) updated = edit(updated, ['$schema'], 'https://opencode.ai/config.json')
  const manifestPath = join(dirname(targetPath(configPath)), '.email-sync-installation.json')
  const record = readInstallationRecord(manifestPath, configPath)
  const plugins = inheritedPlugins(opencodeConfigPath, opencode)
  const matches = plugins.map((value, index) => ownedRegistration(value, entry, configPath, record) ? index : -1).filter(index => index >= 0)
  if (opencode.plugin === undefined) {
    const materialized = plugins.filter((_, index) => !matches.includes(index))
    materialized.push(registration)
    updated = edit(updated, ['plugin'], materialized)
  }
  else if (!matches.length) updated = edit(updated, ['plugin', -1], registration)
  else {
    updated = edit(updated, ['plugin', matches[0]], registration)
    for (const index of matches.slice(1).reverse()) updated = edit(updated, ['plugin', index], undefined)
  }
  const envFile = config.worker.envFile!
  const launcherPath = preflightLauncher(config)
  for (const path of [configPath, opencodeConfigPath, envFile, manifestPath]) preflightFile(path)
  preflightDirectory(config.worker.stateDirectory)
  const distinct = [configPath, opencodeConfigPath, envFile, manifestPath, launcherPath].map(targetPath)
  if (new Set(distinct).size !== distinct.length) throw new Error('Installation config, credential, metadata, and CLI paths must be different files')
  atomicText(configPath, JSON.stringify(raw, null, 2) + '\n', 0o600)
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 })
  try {
    const variables = [...new Set([config.smtp.passwordEnv, config.imap.passwordEnv])]
    writeFileSync(envFile, '# Mailbox passwords/app passwords; read only by the email worker.\n' + variables.map(name => `${name}=""\n`).join(''), { flag: 'wx', mode: 0o600 })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  chmodSync(envFile, 0o600)
  initializeState(config.worker.stateDirectory)
  const launcher = installLauncher(config, configPath, runtime)
  if (updated !== original) {
    if (existsSync(opencodeConfigPath)) {
      try { writeFileSync(`${opencodeConfigPath}.before-email-sync`, original, { flag: 'wx', mode: 0o600 }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    atomicText(opencodeConfigPath, updated, existsSync(opencodeConfigPath) ? statSync(opencodeConfigPath).mode & 0o777 : 0o600)
  }
  atomicText(manifestPath, JSON.stringify({ tool: 'opencode-email-sync', configPath: targetPath(configPath), pluginEntry: entry, opencodeConfigPath: targetPath(opencodeConfigPath) }, null, 2) + '\n', 0o600)
  return { configPath, envFile, opencodeConfigPath, launcher }
}
