import { loadConfig } from '../../src/core/config'
import { workerCredentials } from '../../src/worker/credentials'
import { runSupervisor } from '../../src/worker/supervisor'
import { readState } from '../../src/worker/files'
const args = process.argv.slice(2)
const configPath = args[args.indexOf('--config') + 1]
if (args[0] === 'supervise') {
  const abort = new AbortController()
  process.on('SIGTERM', () => abort.abort())
  await runSupervisor(configPath, abort.signal, { bunPath: process.execPath, cliPath: import.meta.path })
} else {
  const config = loadConfig(configPath)
  const credential = workerCredentials(config).smtp
  const token = readState(config.worker.stateDirectory).token
  const server = Bun.serve({ hostname: '127.0.0.1', port: config.worker.port, fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
    return Response.json({ pid: process.pid, credentialVersion: credential === 'first-test-value' ? 'first' : 'rotated' })
  } })
  process.on('SIGTERM', () => { server.stop(true); process.exit(0) })
}
