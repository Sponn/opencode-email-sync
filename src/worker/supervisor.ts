import { writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../core/config'
import { initializeState, lockWorker } from './files'
import { WorkerClient } from './server'
import { workerCredentials } from './credentials'
import { runtimePaths, type RuntimePaths } from './runtime'
import { sleep } from '../mail/imap'

export async function runSupervisor(configPath: string, signal: AbortSignal, suppliedRuntime?: RuntimePaths): Promise<void> {
  const initial = loadConfig(configPath)
  const stateDirectory = initial.worker.stateDirectory
  const state = initializeState(stateDirectory)
  const release = await lockWorker(stateDirectory, 'supervisor.lock')
  const record = join(stateDirectory, 'supervisor.json')
  let child: ReturnType<typeof Bun.spawn> | undefined
  const update = () => writeFileSync(record, JSON.stringify({ pid: process.pid, workerPid: child?.pid ?? null }), { mode: 0o600 })
  const stop = () => { try { child?.kill('SIGTERM') } catch {} }
  signal.addEventListener('abort', stop, { once: true })
  let waiting = false
  try {
    update()
    while (!signal.aborted) {
      let delay = initial.worker.restartDelayMs
      try {
        const config = loadConfig(configPath)
        delay = config.worker.restartDelayMs
        if (config.worker.stateDirectory !== stateDirectory) throw new Error('State directory changed')
        const client = new WorkerClient(config.worker.port, state.token)
        const healthy = await client.request('status', undefined, AbortSignal.timeout(1000)).then(() => true, () => false)
        if (!healthy && !signal.aborted) {
          // Check readiness inside the dedicated supervisor, never inside OpenCode.
          workerCredentials(config)
          const runtime = suppliedRuntime || runtimePaths(config)
          child = Bun.spawn([runtime.bunPath, '--no-orphans', runtime.cliPath, 'start', '--config', configPath], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
          update(); waiting = false
          if (signal.aborted) stop()
          await child.exited
          child = undefined; update()
        }
      } catch {
        if (!waiting) console.log('Waiting for valid email configuration and worker credentials; retrying automatically.')
        waiting = true
      }
      if (!signal.aborted) await sleep(delay, signal)
    }
  } finally {
    stop(); if (child) await child.exited
    signal.removeEventListener('abort', stop)
    if (existsSync(record)) unlinkSync(record)
    await release()
  }
}
