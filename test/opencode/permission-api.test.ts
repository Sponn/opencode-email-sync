import { expect, test } from 'bun:test'
import { createOpencodeClient } from '@opencode-ai/sdk'
import type { PluginInput } from '@opencode-ai/plugin'
import { permissionGateway } from '../../src/opencode/permission-api'
test('permission access retains the plugin SDK authenticated in-process fetch transport', async () => {
  const requests: { path: string; auth: string | null; body?: unknown }[] = []
  const pending = [{ id: 'per_a', sessionID: 'ses_a', permission: 'bash', patterns: ['printf'], always: ['printf'], metadata: {} }]
  const client = createOpencodeClient({ baseUrl: 'http://in-process.invalid', directory: '/project', headers: { authorization: 'Basic fixture-only' }, async fetch(request) {
    const url = new URL(request.url)
    expect(request.headers.get('authorization')).toBe('Basic fixture-only')
    requests.push({ path: url.pathname, auth: request.headers.get('authorization'), ...(request.method === 'POST' ? { body: await request.json() } : {}) })
    return Response.json(request.method === 'GET' ? pending : true)
  } })
  const gateway = permissionGateway({ client, directory: '/project' } as PluginInput)
  expect(await gateway.list()).toEqual(pending)
  expect(await gateway.reply('ses_a', 'per_a', 'reject')).toBe('accepted')
  expect(requests.map(request => request.path)).toEqual(['/permission', '/session/ses_a/permissions/per_a'])
  expect(requests[1].body).toEqual({ response: 'reject' })
})
