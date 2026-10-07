import { expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { initializeState, lockWorker } from '../../src/worker/files'
test('shared worker identity and token persist with user-only permissions and singleton lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-state-'))
  try {
    const first = initializeState(directory)
    expect(initializeState(directory)).toEqual(first)
    expect((await stat(join(directory, 'token'))).mode & 0o777).toBe(0o600)
    const release = await lockWorker(directory)
    await expect(lockWorker(directory)).rejects.toThrow('already running')
    await release()
    await (await lockWorker(directory))()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
