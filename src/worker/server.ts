import { z } from 'zod'
import type { Store } from '../state/database'
import type { Route, Answer } from '../core/types'
import { routeKey } from '../core/types'

const routeSchema = z.object({ instanceId: z.string().min(1), projectId: z.string().min(1), directory: z.string().min(1), sessionId: z.string().regex(/^ses_[\w-]+$/) })
const sessionSchema = z.object({ route: routeSchema, project: z.string(), title: z.string(), completed: z.array(z.string()) })
const answerSchema = z.object({ route: routeSchema, turnId: z.string().min(1), text: z.string(), project: z.string(), title: z.string() })
const ownerSchema = z.string().min(1).max(200)
const heartbeatMs = 60_000
export function startControlServer(store: Store, token: string, port: number) {
  const adapters = new Map<string, { at: number; routes: Route[] }>()
  let connectionStatus: Record<string, unknown> = {}
  function expire() {
    for (const [owner, adapter] of adapters) if (Date.now() - adapter.at > heartbeatMs) { adapters.delete(owner); store.disconnect(owner) }
  }
  return Object.assign(Bun.serve({
    hostname: '127.0.0.1', port,
    async fetch(request) {
      if (request.headers.get('authorization') !== `Bearer ${token}` || request.headers.has('origin')) return new Response('Unauthorized', { status: 401 })
      const action = new URL(request.url).pathname.slice(1)
      if (request.method === 'GET' && action === 'status') { expire(); return Response.json({ ...store.status(), adapters: adapters.size, mail: connectionStatus }) }
      if (request.method !== 'POST') return new Response('Not found', { status: 404 })
      if (Number(request.headers.get('content-length') || 0) > 8_000_000) return new Response('Request too large', { status: 413 })
      try {
        const reader = request.body?.getReader()
        const chunks: Uint8Array[] = []; let size = 0
        if (reader) while (true) {
          const chunk = await reader.read(); if (chunk.done) break
          size += chunk.value.length; if (size > 8_000_000) { await reader.cancel(); return new Response('Request too large', { status: 413 }) }
          chunks.push(chunk.value)
        }
        const data = JSON.parse(Buffer.concat(chunks).toString())
        expire()
        if (action === 'register') {
          const input = z.object({ adapterId: ownerSchema, sessions: z.array(sessionSchema), scope: routeSchema.omit({ sessionId: true }).optional() }).parse(data)
          const previous = adapters.get(input.adapterId)
          const routes = [...(previous?.routes || [])]
          if (input.scope) for (const route of store.routesFor(input.scope)) if (!routes.some(existing => routeKey(existing) === routeKey(route))) routes.push(route)
          const sessions = input.sessions.map(session => {
            if (!routes.some(route => routeKey(route) === routeKey(session.route))) routes.push(session.route)
            store.registerSession(session.route, session.project, session.title)
            if (store.session(session.route)?.baseline === null) store.baseline(session.route, session.completed)
            return { route: session.route, enabled: store.policy(session.route), baseline: store.session(session.route)?.baseline || [] }
          })
          adapters.set(input.adapterId, { at: Date.now(), routes })
          return Response.json({ sessions })
        }
        if (action === 'heartbeat' || action === 'poll' || action === 'disconnect') {
          const { adapterId } = z.object({ adapterId: ownerSchema }).parse(data)
          const adapter = adapters.get(adapterId)
          if (!adapter) return Response.json({ error: 'Adapter must register' }, { status: 409 })
          adapter.at = Date.now()
          if (action === 'disconnect') { adapters.delete(adapterId); store.disconnect(adapterId); return Response.json({ ok: true }) }
          if (action === 'heartbeat') return Response.json({ ok: true })
          // SQL claims provide single-dispatch ownership even with overlapping registrations.
          return Response.json(adapter.routes.map(route => store.claim(route, adapterId)).filter(Boolean))
        }
        if (action === 'answer') { const answer: Answer = answerSchema.parse(data); store.answer(answer); return Response.json({ ok: true }) }
        if (action === 'baseline') { const { route, completed } = sessionSchema.pick({ route: true, completed: true }).parse(data); store.baseline(route, completed); return Response.json({ ok: true }) }
        if (action === 'command') {
          const { route, action } = z.object({ route: routeSchema, action: z.enum(['on', 'off', 'status']) }).parse(data)
          if (!store.session(route)) return Response.json({ error: 'Session is not registered' }, { status: 404 })
          if (action !== 'status') store.setPolicy(route, action === 'on')
          return Response.json({ enabled: store.policy(route), message: `Email sync is ${store.policy(route) ? 'ON' : 'OFF'} for ${route.sessionId}` })
        }
        if (action === 'policy') { const { route } = z.object({ route: routeSchema }).parse(data); return Response.json({ enabled: store.policy(route), deleted: store.session(route)?.deleted ?? false }) }
        if (action === 'deleted') { const { route } = z.object({ route: routeSchema }).parse(data); store.deleted(route); return Response.json({ ok: true }) }
        if (action === 'ack') {
          const input = z.object({ adapterId: ownerSchema, id: z.string(), status: z.enum(['accepted', 'queued', 'uncertain', 'failed', 'canceled']) }).parse(data)
          store.ack(input.id, input.adapterId, input.status)
          return Response.json({ ok: true })
        }
        if (action === 'begin') {
          const { adapterId, id } = z.object({ adapterId: ownerSchema, id: z.string() }).parse(data)
          return Response.json({ allowed: store.beginDispatch(id, adapterId) })
        }
        if (action === 'resolve') { const { id, action } = z.object({ id: z.string(), action: z.enum(['retry', 'cancel']) }).parse(data); store.resolve(id, action); return Response.json({ ok: true }) }
        return new Response('Not found', { status: 404 })
      } catch (error) { return Response.json({ error: error instanceof z.ZodError ? 'Invalid request payload' : 'Control request failed' }, { status: 400 }) }
    },
  }), { setMailStatus(status: Record<string, unknown>) { connectionStatus = status } })
}
export class WorkerClient {
  constructor(readonly port: number, private readonly token: string) {}
  async request<T = unknown>(action: string, data?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${this.port}/${action}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: signal || AbortSignal.timeout(10000),
    })
    if (!response.ok) throw new Error(`Email worker ${action} failed (${response.status})`)
    return response.json() as Promise<T>
  }
}
