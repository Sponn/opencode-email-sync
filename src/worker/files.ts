import { chmodSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
export function initializeState(directory: string): { token: string; instanceId: string } {
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700)
  const persistent = (name: string) => {
    const path = join(directory, name)
    try { writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    chmodSync(path, 0o600)
    const value = readFileSync(path, 'utf8').trim()
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`Invalid worker ${name} file`)
    return value
  }
  return { token: persistent('token'), instanceId: persistent('instance-id') }
}
export function readState(directory: string) {
  return { token: readFileSync(join(directory, 'token'), 'utf8').trim(), instanceId: readFileSync(join(directory, 'instance-id'), 'utf8').trim() }
}
export async function lockWorker(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, 'worker.lock')
  closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600)
  // The kernel owns exclusion and releases it automatically after a crash.
  // Never unlink the lock pathname: that would create independently lockable
  // inodes during takeover. The child exits on EOF when its parent dies.
  const child = Bun.spawn(['flock', '--exclusive', '--nonblock', path, 'sh', '-c', 'printf "locked\\n"; read -r release'], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  })
  const reader = child.stdout.getReader()
  const ready = await reader.read()
  reader.releaseLock()
  if (ready.done || !new TextDecoder().decode(ready.value).includes('locked')) {
    child.stdin.end(); await child.exited
    throw new Error('Email worker is already running or flock could not acquire the state lock')
  }
  return async () => { child.stdin.end(); await child.exited }
}
