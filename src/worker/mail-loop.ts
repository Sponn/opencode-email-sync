import { createHash } from 'node:crypto'
import type { Config } from '../core/config'
import { normalizeAddress } from '../core/config'
import { parseCommand } from '../core/commands'
import type { Store } from '../state/database'
import { authorize, extractReply, parseIncoming } from '../mail/parse'
import { renderMail } from '../mail/render'
import type { MailSender } from '../mail/smtp'

export async function ingestPending(store: Store, config: Config): Promise<void> {
  for (const incoming of store.pendingMail()) {
    let mail
    try { mail = await parseIncoming(Buffer.from(incoming.raw, 'base64'), config.maxMessageBytes) }
    catch { store.processedMail(incoming.id); continue }
    const sender = normalizeAddress(mail.from[0] || '')
    const thread = store.thread(mail.references, sender)
    if (!authorize(mail, config, thread) || !thread) { store.processedMail(incoming.id); continue }
    const reply = extractReply(mail)
    store.transaction(() => {
      const confirm = (text: string) => store.addDelivery({ route: thread.route, project: thread.project, title: thread.title, text }, sender, true, mail.messageId)
      if (reply.kind === 'ambiguous') confirm('Please put your reply above a standalone --- end reply --- delimiter so quoted history is not sent as instructions.')
      if (reply.kind === 'text') {
        const command = parseCommand(reply.text)
        if (command.kind === 'invalid') confirm('Use one standalone command: !opencode-email-sync session on, off, or status.')
        else if (command.kind === 'command') {
          if (command.action !== 'status') store.setPolicy(thread.route, command.action === 'on')
          confirm(`Email sync is ${store.policy(thread.route) ? 'ON' : 'OFF'} for ${thread.route.sessionId}`)
        } else if (store.session(thread.route)?.deleted) confirm('This OpenCode session was deleted; your reply was not submitted.')
        else if (store.policy(thread.route)) store.enqueue(thread.route, incoming.id, command.text, sender)
      }
      store.processedMail(incoming.id)
    })
  }
}
export function incomingIdentity(raw: Uint8Array, messageId?: string): string {
  // Same message across mailbox UID resets is still one instruction. Different
  // content with an identical Message-ID is held as the same message when present.
  return createHash('sha256').update(messageId || raw).digest('hex')
}
export async function flushDeliveries(store: Store, config: Config, sender: MailSender): Promise<void> {
  for (const delivery of store.deliveries()) {
    if (!config.recipients.includes(delivery.recipient)) { store.finishDelivery(delivery, 'canceled'); continue }
    if (!store.startDelivery(delivery)) continue
    try { store.finishDelivery(delivery, await sender.send(renderMail(delivery, config))) }
    catch (error) {
      const permanent = error instanceof Error && 'permanent' in error && error.permanent
      store.finishDelivery(delivery, permanent ? 'failed' : 'queued', Date.now() + Math.min(config.retry.maxMs, config.retry.initialMs * 2 ** Math.min(delivery.attempts, 10)))
    }
  }
}
