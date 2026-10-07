import type { PluginInput, Hooks } from '@opencode-ai/plugin'
import type { Session } from '@opencode-ai/sdk'
import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { delimiter } from 'node:path'
import { loadConfig } from '../core/config'
import { readState } from '../worker/files'
import { WorkerClient } from '../worker/server'
import { completedAnswers, shellContext, type MessageRecord } from './answers'
import { dispatch, SessionDeletedError, type HistoryMessage } from './dispatch'
import type { Route, PromptJob } from '../core/types'

export function createAdapter(input: PluginInput, configPath: string): Hooks {
  const config = loadConfig(configPath)
  const adapterId = randomUUID()
  const started = Date.now()
  let stopped = false, scanning = false, polling = false
  let worker: WorkerClient | undefined, instanceId: string | undefined
  const baseline = new Map<string, string[]>()
  const initial = new Map<string, string[]>()
  const routes = new Map<string, Route>()
  const registered = new Set<string>()
  const inflight = new Set<string>()
  const project = (input.project as { name?: string }).name || basename(input.worktree) || basename(input.directory)
  const routeFor = (sessionId: string): Route => ({ instanceId: instanceId!, projectId: input.project.id, directory: resolve(input.directory), sessionId })
  let warned = false
  async function warning() {
    if (warned || stopped) return
    warned = true
    await input.client.app.log({ body: { service: 'email-sync', level: 'warn', message: 'Email worker unavailable; retrying. Start opencode-email-sync with the configured state directory.' } }).catch(() => {})
  }
  function connect() {
    const state = readState(config.worker.stateDirectory)
    instanceId = state.instanceId
    worker = new WorkerClient(config.worker.port, state.token)
    return worker
  }
  async function messages(sessionId: string) {
    const result = await input.client.session.messages({ path: { id: sessionId } })
    if (result.error || !result.data) throw new Error('Could not read session messages')
    return result.data
  }
  async function syncSession(session: Session) {
    if (session.parentID || resolve(session.directory) !== resolve(input.directory)) return
    const client = worker || connect()
    const route = routeFor(session.id)
    routes.set(session.id, route)
    const history = await messages(session.id)
    const answers = completedAnswers(history as MessageRecord[], route, project, session.title)
    if (!initial.has(session.id)) {
      // A turn completed after plugin startup is new even if the first scan was
      // delayed by worker startup. Active historical turns must not be lost.
      initial.set(session.id, answers.filter(answer => {
        const last = history.findLast(message => message.info.role === 'assistant' && message.info.parentID === answer.turnId)
        return last?.info.role === 'assistant' && (last.info.time.completed || Infinity) < started
      }).map(answer => answer.turnId))
    }
    if (!registered.has(session.id)) {
      const response = await client.request<{ sessions: { baseline: string[] }[] }>('register', { adapterId, sessions: [{ route, project, title: session.title, completed: initial.get(session.id) }] })
      baseline.set(session.id, response.sessions[0].baseline)
      registered.add(session.id)
    }
    const seen = new Set(baseline.get(session.id) || [])
    for (const answer of answers) {
      if (seen.has(answer.turnId)) continue
      await client.request('answer', answer)
      seen.add(answer.turnId)
    }
    await client.request('baseline', { route, completed: [...seen] })
    baseline.set(session.id, [...seen])
  }
  async function scan() {
    if (stopped || scanning) return
    scanning = true
    try {
      connect()
      const sessions = await input.client.session.list()
      if (!sessions.data || sessions.error) throw new Error('Could not list sessions')
      await worker!.request('register', { adapterId, sessions: [], scope: { instanceId: instanceId!, projectId: input.project.id, directory: resolve(input.directory) } })
      for (const session of sessions.data) { if (stopped) break; await syncSession(session) }
      // Register empty projects so polling/heartbeat works before their first session.
      if (!registered.size) await worker!.request('register', { adapterId, sessions: [] })
      await worker!.request('heartbeat', { adapterId })
      warned = false
    } catch { worker = undefined; registered.clear(); await warning() }
    finally { scanning = false }
  }
  async function execute(job: PromptJob) {
    if (inflight.has(job.route.sessionId) || !worker) return
    inflight.add(job.route.sessionId)
    const client = worker
    try {
      const policy = await client.request<{ enabled: boolean; deleted: boolean }>('policy', { route: job.route })
      const result = policy.deleted ? 'failed' : await dispatch({
        async messages() {
          const session = await input.client.session.get({ path: { id: job.route.sessionId } })
          if (session.response.status === 404) { await client.request('deleted', { route: job.route }); throw new SessionDeletedError('Session deleted') }
          if (session.error || !session.data) throw new Error('Session unavailable')
          return await messages(job.route.sessionId) as HistoryMessage[]
        },
        async busy() { const result = await input.client.session.status(); if (result.error || !result.data) throw new Error('Session status unavailable'); return result.data[job.route.sessionId]?.type !== undefined && result.data[job.route.sessionId]?.type !== 'idle' },
        async authorize() { return (await client.request<{ allowed: boolean }>('begin', { adapterId, id: job.id })).allowed },
        async submit(body) {
          // The 1.18.34 server accepts variant although the v1 SDK generated
          // PromptData omits it. Sending the extra body property preserves it.
          const result = await input.client.session.prompt({ path: { id: job.route.sessionId }, body })
          if (result.error || !result.data) throw new Error('Prompt acceptance uncertain')
        },
      }, job, policy.enabled)
      await client.request('ack', { adapterId, id: job.id, status: result })
    } catch { await client.request('ack', { adapterId, id: job.id, status: 'uncertain' }).catch(() => {}) }
    finally { inflight.delete(job.route.sessionId) }
  }
  async function poll() {
    if (stopped || polling || !worker) return
    polling = true
    try {
      const jobs = await worker.request<PromptJob[]>('poll', { adapterId })
      for (const job of jobs) void execute(job)
    } catch { registered.clear(); worker = undefined }
    finally { polling = false }
  }
  // SDK calls must occur after plugin initialization, not from inside config
  // bootstrapping, or the server's instance initialization can deadlock.
  const scanTimer = setInterval(() => { void scan() }, 3000)
  const pollTimer = setInterval(() => { void poll() }, 500)
  const first = setTimeout(() => { void scan() }, 0)
  return {
    'shell.env': async ({ sessionID }, output) => {
      if (!sessionID) return
      output.env.OPENCODE_EMAIL_CONFIG = configPath
      output.env.PATH = `${config.worker.binDirectory}${delimiter}${output.env.PATH || process.env.PATH || ''}`
      try {
        connect()
        Object.assign(output.env, shellContext(routeFor(sessionID), configPath))
        const session = await input.client.session.get({ path: { id: sessionID } })
        if (session.data && !session.error) await syncSession(session.data)
      } catch { await warning() }
    },
    event: async ({ event }) => {
      if (stopped) return
      if (event.type === 'session.deleted') {
        const route = routes.get(event.properties.info.id)
        if (route) await worker?.request('deleted', { route }).catch(() => {})
        return
      }
      if (['session.created', 'session.updated', 'session.idle'].includes(event.type)) void scan()
    },
    dispose: async () => {
      stopped = true; clearTimeout(first); clearInterval(scanTimer); clearInterval(pollTimer)
      await worker?.request('disconnect', { adapterId }).catch(() => {})
    },
  }
}
