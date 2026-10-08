import { expect, test } from 'bun:test'
import { Store } from '../../src/state/database'
import { startControlServer, WorkerClient } from '../../src/worker/server'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
const request = { id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['git push *'], always: ['git push *'], metadata: { command: 'git push' } }
test('permission controls are independently leased while an ordinary prompt is dispatching', async () => {
  const store = new Store(':memory:', ['me@example.com']); const server = startControlServer(store, 'token', 0); const client = new WorkerClient(server.port!, 'token')
  try {
    await client.request('register', { adapterId: 'adapter', sessions: [{ route, project: 'P', title: 'S', completed: [] }] })
    store.enqueue(route, 'prompt', 'Make a change', 'me@example.com'); store.claim(route, 'adapter'); store.beginDispatch('prompt', 'adapter')
    await client.request('permissions-sync', { adapterId: 'adapter', route, requests: [request] })
    const decision = await client.request<any>('permission-command', { route, action: 'once' })
    expect(decision.ok).toBe(true)
    const jobs = await client.request<any[]>('permission-poll', { adapterId: 'adapter' })
    expect(jobs).toHaveLength(1)
    expect(jobs[0].requestId).toBe('per_a')
    expect((await client.request<any>('permission-begin', { adapterId: 'adapter', id: jobs[0].id })).allowed).toBe(true)
    await client.request('permission-ack', { adapterId: 'adapter', id: jobs[0].id, outcome: 'accepted' })
    expect((await client.request<any>('permission-result', { id: jobs[0].id })).status).toBe('accepted')
  } finally { server.stop(true); store.close() }
})
test('explicit request ID can be answered from another shell session only in the same project', async () => {
  const store = new Store(':memory:', ['me@example.com']); const server = startControlServer(store, 'token', 0); const client = new WorkerClient(server.port!, 'token')
  try {
    const other = { ...route, sessionId: 'ses_control' }
    await client.request('register', { adapterId: 'adapter', sessions: [{ route, project: 'P', title: 'S', completed: [] }, { route: other, project: 'P', title: 'Control', completed: [] }] })
    await client.request('permissions-sync', { adapterId: 'adapter', route, requests: [request] })
    expect((await client.request<any>('permission-command', { route: { ...other, directory: '/other-project' }, action: 'always', requestId: 'per_a' })).ok).toBe(false)
    expect((await client.request<any>('permission-command', { route: other, action: 'once' })).ok).toBe(false)
    expect((await client.request<any>('permission-command', { route: other, action: 'once', requestId: 'per_a' })).ok).toBe(true)
    const jobs = await client.request<any[]>('permission-poll', { adapterId: 'adapter' })
    expect(jobs[0].route.sessionId).toBe('ses_a')
  } finally { server.stop(true); store.close() }
})
