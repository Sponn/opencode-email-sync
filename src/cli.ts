#!/usr/bin/env bun
import { join } from 'node:path'
import { loadConfig, defaultConfigPath } from './core/config'
import { workerCredentials } from './worker/credentials'
import { initializeState, readState, lockWorker } from './worker/files'
import { startControlServer, WorkerClient } from './worker/server'
import { Store } from './state/database'
import { createSmtp } from './mail/smtp'
import { startImap, sleep } from './mail/imap'
import { ingestPending, flushDeliveries } from './worker/mail-loop'
import { runSupervisor } from './worker/supervisor'
import { install } from './worker/install'

const help = `OpenCode email sync\n\nCommands:\n  install [--config PATH] [--opencode-config PATH] [--state-directory PATH] [--bun PATH]\n  init --config PATH\n  start --config PATH\n  supervise --config PATH\n  status --config PATH\n  session on|off|status [--config PATH]\n  resolve --job ID --action retry|cancel [--config PATH]\n\nSession commands use the current OpenCode shell context. In the web UI and email:\n  !opencode-email-sync session on\n  !opencode-email-sync session off\n  !opencode-email-sync session status\n`
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { console.log(help); return }
  const option = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`); return args[index + 1] }
  const path = option('--config') || process.env.OPENCODE_EMAIL_CONFIG || defaultConfigPath()
  if (args[0] === 'install') {
    const result = install({ configPath: path, opencodeConfigPath: option('--opencode-config'), stateDirectory: option('--state-directory'), bunPath: option('--bun') })
    console.log(`Installed email sync.\nMail settings: ${result.configPath}\nCredentials: ${result.envFile}\nOpenCode configuration: ${result.opencodeConfigPath}\nCLI: ${result.launcher}\nQuit and restart OpenCode to load the plugin.`)
    return
  }
  const config = loadConfig(path)
  const command = args[0]
  if (command === 'supervise') {
    const abort = new AbortController()
    const stop = () => abort.abort()
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    try { await runSupervisor(path, abort.signal) }
    finally { process.off('SIGTERM', stop); process.off('SIGINT', stop) }
    return
  }
  if (command === 'init') { initializeState(config.worker.stateDirectory); console.log(`Initialized email-sync state at ${config.worker.stateDirectory}`); return }
  if (command === 'start') {
    const credentials = workerCredentials(config)
    const state = initializeState(config.worker.stateDirectory)
    const release = await lockWorker(config.worker.stateDirectory)
    const store = new Store(join(config.worker.stateDirectory, 'state.sqlite'), config.recipients)
    let server: ReturnType<typeof startControlServer> | undefined
    const abort = new AbortController()
    const stop = () => abort.abort()
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    const smtp = createSmtp(config, credentials)
    try {
      server = startControlServer(store, state.token, config.worker.port)
      let imapState = 'starting'
      const imap = startImap(config, credentials.imap, store, abort.signal, value => { imapState = value; server?.setMailStatus({ imap: imapState }) })
      console.log(`Email worker listening on 127.0.0.1:${server.port}`)
      try {
        while (!abort.signal.aborted) { await ingestPending(store, config); await flushDeliveries(store, config, smtp); await sleep(500, abort.signal) }
      } finally { abort.abort(); await imap }
    } finally { abort.abort(); server?.stop(true); await smtp.close(); store.close(); await release(); process.off('SIGTERM', stop); process.off('SIGINT', stop) }
    return
  }
  const state = readState(config.worker.stateDirectory)
  const client = new WorkerClient(config.worker.port, state.token)
  if (command === 'status') { console.log(JSON.stringify(await client.request('status'), null, 2)); return }
  if (command === 'session') {
    const action = args[1]
    if (!['on', 'off', 'status'].includes(action)) throw new Error('Usage: !opencode-email-sync session on|off|status')
    if (!process.env.OPENCODE_EMAIL_ROUTE) throw new Error('Run session commands in OpenCode shell mode; the current session route is required')
    const route = JSON.parse(process.env.OPENCODE_EMAIL_ROUTE)
    const result = await client.request<{ message: string }>('command', { route, action })
    console.log(result.message)
    return
  }
  if (command === 'resolve') {
    const id = option('--job'); const action = option('--action')
    if (!id || !action || !['retry', 'cancel'].includes(action)) throw new Error('resolve requires --job ID --action retry|cancel')
    await client.request('resolve', { id, action }); console.log(`Resolution recorded for ${id}`); return
  }
  throw new Error(`Unknown command: ${command}`)
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : 'Email sync command failed'); process.exitCode = 1 })
