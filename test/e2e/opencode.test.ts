import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeState } from '../../src/worker/files'
import { Store } from '../../src/state/database'
import { startControlServer } from '../../src/worker/server'
import { disposableOpenCode, until } from '../fixtures/opencode'
import { ingestPending } from '../../src/worker/mail-loop'
import { loadConfig } from '../../src/core/config'
import { chromium } from 'playwright'

test('real OpenCode routes two projects, shell controls and email replies without control model calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-e2e-'))
  const state = initializeState(directory)
  const store = new Store(':memory:', ['me@example.com', 'second@example.com'])
  const worker = startControlServer(store, state.token, 0)
  let opencode: Awaited<ReturnType<typeof disposableOpenCode>> | undefined
  try {
    opencode = await disposableOpenCode(join(directory, 'config.json'), worker.port!, directory)
    const app = opencode
    const sessionA = await app.request(app.projectA, '/session', { title: 'Project A' })
    const sessionB = await app.request(app.projectB, '/session', { title: 'Project B' })
    const routeA = { instanceId: state.instanceId, projectId: sessionA.projectID, directory: app.projectA, sessionId: sessionA.id }
    await until(async () => !!store.session(routeA))
    const prefix = `${JSON.stringify(process.execPath)} ${JSON.stringify(join(process.cwd(), 'src/cli.ts'))}`
    const calls = app.modelCalls()
    const off = await app.request(app.projectA, `/session/${sessionA.id}/shell`, { agent: 'build', command: `${prefix} session off` })
    expect(off.parts[0].state.output).toContain('Email sync is OFF')
    expect(app.modelCalls()).toBe(calls)
    expect(store.policy(routeA)).toBe(false)
    await app.request(app.projectA, `/session/${sessionA.id}/shell`, { agent: 'build', command: `${prefix} session on` })
    expect(app.modelCalls()).toBe(calls)
    expect(store.policy(routeA)).toBe(true)
    await app.request(app.projectA, `/session/${sessionA.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Make change A' }] })
    await app.request(app.projectB, `/session/${sessionB.id}/message`, { agent: 'build', parts: [{ type: 'text', text: 'Make change B' }] })
    await until(async () => store.deliveries().length === 4)
    const deliveries = store.deliveries()
    expect(new Set(deliveries.map(mail => mail.route.sessionId)).size).toBe(2)
    expect(deliveries.every(mail => mail.text.includes('requested change'))).toBe(true)
    const notification = deliveries.find(mail => mail.route.sessionId === sessionA.id && mail.recipient === 'me@example.com')!
    store.finishDelivery(notification, 'sent')
    store.ingest('reply-continue', Buffer.from(`From: me@example.com\r\nMessage-ID: <continue@example.com>\r\nIn-Reply-To: ${notification.messageId}\r\nContent-Type: text/plain\r\n\r\nContinue project A`).toString('base64'))
    await ingestPending(store, loadConfig(join(directory, 'config.json')))
    await until(async () => (await app.request<any[]>(app.projectA, `/session/${sessionA.id}/message`)).some(message => message.info.role === 'user' && message.parts.some((part: any) => part.text === 'Continue project A')))
    const messagesB = await app.request<any[]>(app.projectB, `/session/${sessionB.id}/message`)
    expect(messagesB.some(message => message.parts.some((part: any) => part.text === 'Continue project A'))).toBe(false)
    const job = store.db.query("SELECT * FROM prompts WHERE id='reply-continue'").get() as any
    const messagesA = await app.request<any[]>(app.projectA, `/session/${sessionA.id}/message`)
    expect(messagesA.some(message => message.info.id === job.messageId)).toBe(true)
    // Persisted routes survive adapters going offline. A missing session that
    // was absent from the current inventory must still receive terminal handling.
    const staleRoute = { ...routeA, sessionId: 'ses_deleted_while_offline' }
    store.registerSession(staleRoute, 'Project A', 'Deleted while offline')
    store.enqueue(staleRoute, 'reply-deleted', 'Continue missing session', 'me@example.com')
    await until(async () => store.deliveries().some(delivery => delivery.route.sessionId === staleRoute.sessionId && delivery.text.includes('deleted')))
    expect(store.session(staleRoute)?.deleted).toBe(true)
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    try {
      const page = await browser.newPage()
      await page.goto(`${app.base}/${Buffer.from(app.projectA).toString('base64url')}/session/${sessionA.id}`)
      const editor = page.locator('[contenteditable="true"]').last()
      await editor.waitFor({ timeout: 30000 })
      const before = app.modelCalls()
      await editor.click()
      await page.keyboard.press('!')
      await page.keyboard.insertText(`${prefix} session status`)
      const shellResponse = page.waitForResponse(response => response.url().includes('/shell'))
      await page.keyboard.press('Enter')
      expect((await shellResponse).status()).toBe(200)
      await page.getByText('Shell', { exact: true }).last().click()
      try { await page.getByText(`Email sync is ON for ${sessionA.id}`, { exact: false }).last().waitFor({ timeout: 20000 }) }
      catch (error) { console.log('Browser text:', await page.locator('body').innerText()); console.log('OpenCode logs:', app.logs().slice(-4000)); throw error }
      expect(app.modelCalls()).toBe(before)
    } finally { await browser.close() }
  } finally { await opencode?.close(); worker.stop(true); store.close(); await rm(directory, { recursive: true, force: true }) }
}, 90000)
