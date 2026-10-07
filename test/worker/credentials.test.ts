import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateConfig } from '../../src/core/config'
import { workerCredentials } from '../../src/worker/credentials'
test('worker reads credential files afresh without mutating the OpenCode environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-credentials-'))
  const envFile = join(directory, 'worker.env')
  const input = { account: { address: 'bot@example.com' }, recipients: ['me@example.com'], smtp: { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'SMTP_TEST_SECRET' }, imap: { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'IMAP_TEST_SECRET' }, worker: { envFile } }
  const before = process.env.SMTP_TEST_SECRET
  try {
    await writeFile(envFile, 'SMTP_TEST_SECRET="first password"\nIMAP_TEST_SECRET="imap password"\n')
    const config = validateConfig(input)
    expect(workerCredentials(config, {})).toEqual({ smtp: 'first password', imap: 'imap password' })
    expect(workerCredentials(config, { SMTP_TEST_SECRET: '' }).smtp).toBe('first password')
    await writeFile(envFile, 'SMTP_TEST_SECRET="changed"\nIMAP_TEST_SECRET="changed too"\n')
    expect(workerCredentials(config, {})).toEqual({ smtp: 'changed', imap: 'changed too' })
    expect(workerCredentials(config, { SMTP_TEST_SECRET: 'environment override' }).smtp).toBe('environment override')
    expect(process.env.SMTP_TEST_SECRET).toBe(before)
    await writeFile(envFile, 'SMTP_TEST_SECRET=""\nIMAP_TEST_SECRET=""\n')
    expect(() => workerCredentials(config, {})).toThrow('SMTP_TEST_SECRET')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
