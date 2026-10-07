import { expect, test } from 'bun:test'
import { mkdtemp, rm, readFile, unlink, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateConfig } from '../../src/core/config'
import { installLauncher, runtimePaths } from '../../src/worker/runtime'
import { ensureWorker } from '../../src/worker/bootstrap'
test('runtime discovery finds source CLI and rootless launcher safely quotes paths and is recreated', async () => {
  const directory = await mkdtemp(join(tmpdir(), "email runtime's "))
  const configPath = join(directory, 'config.json')
  const config = validateConfig({ account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' }, worker: { binDirectory: './bin', bunPath: process.execPath } }, configPath)
  try {
    const runtime = runtimePaths(config)
    expect(runtime.cliPath.endsWith('src/cli.ts')).toBe(true)
    const launcher = installLauncher(config, configPath, runtime)
    await access(launcher)
    const process = Bun.spawn([launcher, '--help'], { stdout: 'pipe', stderr: 'pipe' })
    expect(await process.exited).toBe(0)
    expect(await new Response(process.stdout).text()).toContain('OpenCode email sync')
    const before = await readFile(launcher, 'utf8')
    await unlink(launcher)
    installLauncher(config, configPath, runtime)
    expect(await readFile(launcher, 'utf8')).toBe(before)
    await Bun.write(configPath, JSON.stringify(config))
    await unlink(launcher)
    expect(await ensureWorker(configPath)).toBeUndefined()
    expect(await Bun.file(launcher).exists()).toBe(true)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
