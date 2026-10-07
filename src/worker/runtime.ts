import { accessSync, constants, existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { Config } from '../core/config'
import { atomicText, preflightDirectory, preflightFile } from './install-files'

export interface RuntimePaths { bunPath: string; cliPath: string }
export function runtimePaths(config: Config, moduleUrl = import.meta.url): RuntimePaths {
  const directory = dirname(fileURLToPath(moduleUrl))
  const cliPath = [join(directory, 'cli.js'), join(directory, 'cli.ts'), resolve(directory, '../cli.ts')].find(existsSync)
  if (!cliPath) throw new Error('Email worker CLI was not found beside the plugin; build/install the complete package')
  const candidates = config.worker.bunPath ? [config.worker.bunPath] : [Bun.which('bun'), /^bun(?:\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : null, join(process.env.BUN_INSTALL || join(homedir(), '.bun'), 'bin/bun')]
  const bunPath = candidates.find((path): path is string => { if (!path) return false; try { accessSync(path, constants.X_OK); return true } catch { return false } })
  if (!bunPath) throw new Error('Bun runtime not found; configure worker.bunPath or install Bun on PATH')
  return { bunPath, cliPath }
}
export function pluginEntry(cliPath: string): string {
  const path = [join(dirname(cliPath), 'index.js'), join(dirname(cliPath), 'index.ts')].find(existsSync)
  if (!path) throw new Error('Email plugin entry not found beside the CLI')
  return path
}
const marker = '# Managed by opencode-email-sync; regenerated on startup.'
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`
export function preflightLauncher(config: Config): string {
  const path = join(config.worker.binDirectory, 'opencode-email-sync')
  preflightDirectory(config.worker.binDirectory)
  preflightFile(path)
  if (existsSync(path) && !readFileSync(path, 'utf8').includes(marker)) throw new Error('CLI path contains an unmanaged file; choose a different worker.binDirectory')
  return path
}
export function installLauncher(config: Config, configPath: string, runtime: RuntimePaths): string {
  const path = preflightLauncher(config)
  mkdirSync(config.worker.binDirectory, { recursive: true, mode: 0o700 })
  const text = `#!/bin/sh\n${marker}\nexport OPENCODE_EMAIL_CONFIG=${quote(resolve(configPath))}\nexec ${quote(runtime.bunPath)} ${quote(runtime.cliPath)} "$@"\n`
  if (existsSync(path)) {
    const previous = readFileSync(path, 'utf8')
    if (previous === text) { chmodSync(path, 0o755); return path }
  }
  atomicText(path, text, 0o755)
  return path
}
