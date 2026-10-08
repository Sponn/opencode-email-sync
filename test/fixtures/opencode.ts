import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
export async function disposableOpenCode(configPath: string, workerPort: number, stateDirectory: string, mail?: { smtp: Record<string, unknown>; imap: Record<string, unknown> }, options: { permissionProbe?: boolean; serverPassword?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'email-opencode-'))
  const projectA = join(home, 'project-a'); const projectB = join(home, 'project-b')
  await mkdir(projectA); await mkdir(projectB)
  let modelCalls = 0
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    modelCalls++
    const input = await request.json() as any
    const answer = '## Completed\n\nThe requested change is ready.\n\n```ts\nconst ready = true\n```'
    const tool = options.permissionProbe && input.messages.findLastIndex((message: any) => message.role === 'user') > input.messages.findLastIndex((message: any) => message.role === 'tool')
    const toolCall = { id: 'call_permission_probe', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: "printf 'permission-probe'", description: 'Run the harmless permission probe' }) } }
    if (!input.stream) return Response.json({ id: 'completion', object: 'chat.completion', created: 1, model: 'probe', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
    const events = [
      { id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta: tool ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] } : { role: 'assistant', content: answer }, finish_reason: null }] },
      { id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() }); const port = holder.port!; holder.stop(true)
  await writeFile(configPath, JSON.stringify({ account: { address: 'bot@example.com' }, recipients: ['me@example.com', 'second@example.com'], smtp: mail?.smtp || { host: 'localhost', port: 465, username: 'bot', passwordEnv: 'PASS' }, imap: mail?.imap || { host: 'localhost', port: 993, username: 'bot', passwordEnv: 'PASS' }, worker: { port: workerPort, stateDirectory } }))
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_CACHE_HOME: join(home, 'cache'), XDG_STATE_HOME: join(home, 'state'), OPENCODE_CONFIG_DIR: join(home, 'config/opencode'), OPENCODE_CONFIG: '', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_SERVER_PASSWORD: options.serverPassword || '', OPENCODE_CONFIG_CONTENT: JSON.stringify({
    plugin: [[`file://${resolve(process.env.EMAIL_SYNC_BUILT_TEST ? 'dist/index.js' : 'src/index.ts')}`, { configPath }]], model: 'probe/probe',
    ...(options.permissionProbe ? { permission: { bash: 'ask' } } : {}),
    provider: { probe: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.port}/v1`, apiKey: 'test-only' }, models: { probe: { name: 'Probe', limit: { context: 100000, output: 1000 } } } } },
  }) }
  const child = Bun.spawn(['opencode', 'serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], { cwd: projectA, env, stdout: 'pipe', stderr: 'pipe' })
  let logs = ''
  async function drain(stream: ReadableStream<Uint8Array>) { const reader = stream.getReader(); while (true) { const chunk = await reader.read(); if (chunk.done) break; logs += new TextDecoder().decode(chunk.value) } }
  const drains = [drain(child.stdout), drain(child.stderr)]
  const base = `http://127.0.0.1:${port}`
  const headers: Record<string, string> = options.serverPassword ? { authorization: `Basic ${Buffer.from(`opencode:${options.serverPassword}`).toString('base64')}` } : {}
  const request = async <T = any>(directory: string, path: string, data?: unknown): Promise<T> => {
    const response = await fetch(`${base}${path}?directory=${encodeURIComponent(directory)}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30000) })
    const body = await response.text()
    if (!response.ok) throw new Error(`OpenCode ${response.status}: ${body}\n${logs.slice(-5000)}`)
    return JSON.parse(body)
  }
  const close = async () => { child.kill('SIGKILL'); await child.exited; await Promise.all(drains); model.stop(true); await rm(home, { recursive: true, force: true }) }
  try {
    await until(async () => { try { return (await fetch(`${base}/global/health`, { headers, signal: AbortSignal.timeout(1000) })).ok } catch { return false } }, 30000)
    return { home, projectA, projectB, base, headers, request, close, modelCalls: () => modelCalls, logs: () => logs }
  } catch (error) { await close(); throw error }
}
export async function until(check: () => Promise<boolean>, timeout = 15000) {
  const start = Date.now()
  while (!(await check())) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await Bun.sleep(100) }
}
