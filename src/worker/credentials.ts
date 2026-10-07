import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'
import { resolveCredentials, type Config } from '../core/config'

// Only worker entry points import this module. Parsing does not populate the
// parent's process.env and values are never written into configuration/state.
export function workerCredentials(config: Config, env: Record<string, string | undefined> = process.env) {
  const file = config.worker.envFile ? parse(readFileSync(config.worker.envFile)) : {}
  const overrides = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''))
  return resolveCredentials(config, { ...file, ...overrides })
}
