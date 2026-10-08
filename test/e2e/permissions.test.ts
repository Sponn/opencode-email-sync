import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../../src/state/database'
import { initializeState } from '../../src/worker/files'
import { startControlServer } from '../../src/worker/server'
import { ingestPending } from '../../src/worker/mail-loop'
import { loadConfig } from '../../src/core/config'
import { renderMail } from '../../src/mail/render'
import { disposableOpenCode, until } from '../fixtures/opencode'

test('real authenticated OpenCode pauses, sends permission options, and resumes on the exact email decision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-permission-e2e-'))
  const state = initializeState(directory); const store = new Store(':memory:', ['me@example.com', 'second@example.com'])
  const server = startControlServer(store, state.token, 0)
  let app: Awaited<ReturnType<typeof disposableOpenCode>> | undefined
  try {
    const configPath = join(directory, 'config.json')
    app = await disposableOpenCode(configPath, server.port!, directory, undefined, { permissionProbe: true, serverPassword: 'fixture-password' })
    const current = app
    const session = await current.request(current.projectA, '/session', { title: 'Paused permission test' })
    const route = { instanceId: state.instanceId, projectId: session.projectID, directory: current.projectA, sessionId: session.id }
    const prompt = current.request(current.projectA, `/session/${session.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Run the harmless permission probe' }] })
    let promptCompleted = false
    const completed = prompt.then(result => { promptCompleted = true; return result })
    void completed.catch(() => {})
    await until(async () => (await current.request<any[]>(current.projectA, '/permission')).length === 1)
    expect(promptCompleted).toBe(false)
    await until(async () => store.deliveries().filter(mail => !!mail.permissionKey).length === 2, 12000)
    const notification = store.deliveries().find(mail => mail.recipient === 'me@example.com')!
    const mail = renderMail(notification, loadConfig(configPath))
    for (const action of ['once', 'reject', 'always']) expect(mail.text).toContain(`!opencode-email-sync permission ${action}`)
    expect(mail.subject).toContain('Permission required')
    store.finishDelivery(notification, 'sent')
    store.ingest('email-permission-once', Buffer.from(`From: me@example.com\r\nMessage-ID: <once@example.com>\r\nIn-Reply-To: ${notification.messageId}\r\nContent-Type: text/plain\r\n\r\n!opencode-email-sync permission once`).toString('base64'))
    await ingestPending(store, loadConfig(configPath))
    await completed
    await until(async () => store.deliveries().some(mail => mail.control && mail.text.includes('approved once')))
    expect(await current.request<any[]>(current.projectA, '/permission')).toEqual([])
    const messages = await current.request<any[]>(current.projectA, `/session/${session.id}/message`)
    const tool = messages.flatMap(message => message.parts).find(part => part.type === 'tool' && part.tool === 'bash')
    expect(tool.state.output).toContain('permission-probe')
    expect(messages.filter(message => message.info.role === 'user')).toHaveLength(1)
    store.permissions.sync(route, [])
    store.ingest('old-permission-reply', Buffer.from(`From: me@example.com\r\nIn-Reply-To: ${notification.messageId}\r\nContent-Type: text/plain\r\n\r\n!opencode-email-sync permission always`).toString('base64'))
    await ingestPending(store, loadConfig(configPath))
    expect(store.deliveries().some(mail => mail.control && mail.text.includes('already answered or expired'))).toBe(true)
    const rejectSession = await current.request(current.projectA, '/session', { title: 'Reject permission test' })
    const rejectPrompt = current.request(current.projectA, `/session/${rejectSession.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Run the harmless permission probe' }] })
    void rejectPrompt.catch(() => {})
    await until(async () => (await current.request<any[]>(current.projectA, '/permission')).length === 1)
    const rejectRequest = (await current.request<any[]>(current.projectA, '/permission'))[0]
    const shellResponse = await fetch(`${current.base}/session/${rejectSession.id}/shell?directory=${encodeURIComponent(current.projectA)}`, { method: 'POST', headers: { ...current.headers, 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'build', command: 'true' }), signal: AbortSignal.timeout(10000) })
    console.log('Paused-session shell status:', shellResponse.status)
    await until(async () => store.deliveries().some(mail => mail.route.sessionId === rejectSession.id && !!mail.permissionKey))
    const rejectMail = store.deliveries().find(mail => mail.route.sessionId === rejectSession.id && mail.recipient === 'me@example.com')!
    store.finishDelivery(rejectMail, 'sent')
    store.ingest('email-permission-reject', Buffer.from(`From: me@example.com\r\nIn-Reply-To: ${rejectMail.messageId}\r\nContent-Type: text/plain\r\n\r\n!opencode-email-sync permission reject`).toString('base64'))
    await ingestPending(store, loadConfig(configPath)); await rejectPrompt
    await until(async () => store.deliveries().some(mail => mail.control && mail.text.includes(`${rejectRequest.id} rejected`)))
    const rejectedMessages = await current.request<any[]>(current.projectA, `/session/${rejectSession.id}/message`)
    expect(rejectedMessages.flatMap(message => message.parts).find(part => part.type === 'tool' && part.tool === 'bash').state.status).toBe('error')
    const alwaysSession = await current.request(current.projectA, '/session', { title: 'Always permission test' })
    const alwaysPrompt = current.request(current.projectA, `/session/${alwaysSession.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Run the harmless permission probe' }] })
    void alwaysPrompt.catch(() => {})
    await until(async () => (await current.request<any[]>(current.projectA, '/permission')).length === 1)
    const alwaysRequest = (await current.request<any[]>(current.projectA, '/permission'))[0]
    await until(async () => store.deliveries().some(mail => mail.route.sessionId === alwaysSession.id && !!mail.permissionKey))
    const control = await current.request(current.projectA, '/session', { title: 'Permission control shell' })
    const shell = await current.request(current.projectA, `/session/${control.id}/shell`, { agent: 'build', command: `${JSON.stringify(process.execPath)} ${JSON.stringify(join(process.cwd(), 'src/cli.ts'))} permission always ${alwaysRequest.id} --config ${JSON.stringify(configPath)}` })
    expect(shell.parts[0].state.output).toContain('OpenCode accepted permission always')
    await alwaysPrompt
    expect(await current.request<any[]>(current.projectA, '/permission')).toEqual([])
    await current.request(current.projectA, `/session/${alwaysSession.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Run the same matching action again' }] })
    const alwaysMessages = await current.request<any[]>(current.projectA, `/session/${alwaysSession.id}/message`)
    expect(alwaysMessages.flatMap(message => message.parts).filter(part => part.type === 'tool' && part.tool === 'bash' && part.state.status === 'completed')).toHaveLength(2)
    expect(await current.request<any[]>(current.projectA, '/permission')).toEqual([])
    const parent = await current.request(current.projectB, '/session', { title: 'Parent of permission subagent' })
    const child = await current.request(current.projectB, '/session', { title: 'Internal subagent', parentID: parent.id })
    expect(child.parentID).toBe(parent.id)
    const childPrompt = current.request(current.projectB, `/session/${child.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Run the harmless permission probe' }] })
    void childPrompt.catch(() => {})
    await until(async () => (await current.request<any[]>(current.projectB, '/permission')).length === 1)
    await until(async () => store.deliveries().some(mail => mail.route.sessionId === parent.id && !!mail.permissionKey), 12000)
    const childNotice = store.deliveries().find(mail => mail.route.sessionId === parent.id && mail.recipient === 'me@example.com')!
    store.finishDelivery(childNotice, 'sent')
    store.ingest('email-child-permission', Buffer.from(`From: me@example.com\r\nIn-Reply-To: ${childNotice.messageId}\r\nContent-Type: text/plain\r\n\r\n!opencode-email-sync permission once`).toString('base64'))
    await ingestPending(store, loadConfig(configPath)); await childPrompt
    expect(await current.request<any[]>(current.projectB, '/permission')).toEqual([])
    expect(store.deliveries().some(mail => mail.route.sessionId === child.id)).toBe(false)
  } catch (error) { console.log('Permission OpenCode logs:', app?.logs().slice(-5000)); throw error }
  finally { await app?.close(); server.stop(true); store.close(); await rm(directory, { recursive: true, force: true }) }
}, 90000)
