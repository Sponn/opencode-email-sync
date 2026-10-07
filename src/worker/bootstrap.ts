import { spawn, type ChildProcess } from 'node:child_process'
import { openSync, closeSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig } from '../core/config'
import { initializeState } from './files'
import { installLauncher, runtimePaths, type RuntimePaths } from './runtime'

export type SupervisorProcess = ChildProcess & { exited: Promise<number> }
const key = Symbol.for('opencode-email-sync.supervisors')
const globals = globalThis as unknown as Record<symbol, Map<string, SupervisorProcess>>
const supervisors = globals[key] ||= new Map()
export async function ensureWorker(configPath: string, suppliedRuntime?: RuntimePaths): Promise<SupervisorProcess | undefined> {
  const config = loadConfig(configPath)
  if (!config.worker.autoStart && !config.worker.bunPath) return undefined
  const runtime = suppliedRuntime || runtimePaths(config)
  // Do this even when a supervisor exists, to restore a lost ephemeral launcher.
  installLauncher(config, configPath, runtime)
  if (!config.worker.autoStart) return undefined
  initializeState(config.worker.stateDirectory)
  const identity = resolve(configPath)
  const existing = supervisors.get(identity)
  if (existing && existing.exitCode === null && existing.signalCode === null) return existing
  const logPath = join(config.worker.stateDirectory, 'worker.log')
  const log = openSync(logPath, 'a', 0o600); chmodSync(logPath, 0o600)
  try {
    const child = spawn(runtime.bunPath, [runtime.cliPath, 'supervise', '--config', identity], { detached: true, stdio: ['ignore', log, log], env: { ...process.env } }) as SupervisorProcess
    child.exited = new Promise(resolve => {
      child.once('exit', code => { if (supervisors.get(identity) === child) supervisors.delete(identity); resolve(code ?? 1) })
      child.once('error', () => { if (supervisors.get(identity) === child) supervisors.delete(identity); resolve(1) })
    })
    supervisors.set(identity, child)
    child.unref()
    return child
  } finally { closeSync(log) }
}
