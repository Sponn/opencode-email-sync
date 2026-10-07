import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
test('concurrent stale-lock takeover grants exactly one owner per wave', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-lock-race-'))
  try {
    for (let wave = 0; wave < 15; wave++) {
      await writeFile(join(directory, 'worker.lock'), JSON.stringify({ pid: 99999999, nonce: 'stale' }))
      let waiting = 0
      const responses: (() => void)[] = []
      const barrier = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
        waiting++
        const ready = new Promise<void>(resolve => responses.push(resolve))
        if (waiting === 8) for (const response of responses) response()
        await ready
        return new Response('go')
      } })
      const source = `import {lockWorker} from ${JSON.stringify(resolve('src/worker/files.ts'))}; await fetch('http://127.0.0.1:${barrier.port}'); try { const release = await lockWorker(${JSON.stringify(directory)}); console.log('owned'); await Bun.sleep(100); await release() } catch { console.log('denied') }`
      const children = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, '-e', source], { stdout: 'pipe', stderr: 'pipe' }))
      const results = await Promise.all(children.map(async child => { const output = await new Response(child.stdout).text(); await child.exited; return output.trim() }))
      barrier.stop(true)
      expect(results.filter(output => output === 'owned')).toHaveLength(1)
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 15000)
