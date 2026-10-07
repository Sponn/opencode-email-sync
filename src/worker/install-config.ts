import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, type ParseError } from 'jsonc-parser'
import { targetPath } from './install-files'

export interface OpenCodeSettings { $schema?: string; plugin?: unknown[]; [key: string]: unknown }
export function parseOpenCode(text: string): OpenCodeSettings {
  const errors: ParseError[] = []
  const config = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !config || typeof config !== 'object' || Array.isArray(config) || (config.plugin !== undefined && !Array.isArray(config.plugin))) throw new Error('OpenCode configuration is invalid; no installation files were edited')
  return config
}
export function inheritedPlugins(path: string, config: OpenCodeSettings): unknown[] {
  if (config.plugin !== undefined) return config.plugin
  let plugins: unknown[] = []
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    if (name === basename(path)) break
    const earlier = join(dirname(path), name)
    if (existsSync(earlier)) plugins = parseOpenCode(readFileSync(earlier, 'utf8')).plugin ?? plugins
  }
  return plugins
}
export interface InstallationRecord { tool: 'opencode-email-sync'; configPath: string; pluginEntry: string; opencodeConfigPath: string }
export function readInstallationRecord(path: string, configPath: string): InstallationRecord | undefined {
  if (!existsSync(path)) return undefined
  const record = JSON.parse(readFileSync(path, 'utf8'))
  if (record.tool !== 'opencode-email-sync' || typeof record.configPath !== 'string' || typeof record.pluginEntry !== 'string') throw new Error('Installation metadata is invalid; inspect it before reinstalling')
  return targetPath(record.configPath) === targetPath(configPath) ? record : undefined
}
export function ownedRegistration(value: unknown, entry: string, configPath: string, record?: InstallationRecord): boolean {
  const spec = Array.isArray(value) ? value[0] : value
  if (typeof spec !== 'string') return false
  if (spec === entry || /^opencode-email-sync(?:@.*)?$/.test(spec)) return true
  const options = Array.isArray(value) ? value[1] : undefined
  const configured = options && typeof options.configPath === 'string' ? options.configPath : undefined
  if (!configured || targetPath(resolve(configured)) !== targetPath(configPath)) return false
  if (record?.pluginEntry === spec) return true
  try {
    const packagePath = join(dirname(dirname(fileURLToPath(spec))), 'package.json')
    return existsSync(packagePath) && JSON.parse(readFileSync(packagePath, 'utf8')).name === 'opencode-email-sync'
  } catch { return false }
}
