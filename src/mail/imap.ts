import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import type { Config } from '../core/config'
import type { Store } from '../state/database'
import { parseIncoming } from './parse'
import { incomingIdentity } from '../worker/mail-loop'

export function imapOptions(config: Config, password: string): ImapFlowOptions {
  const imap = config.imap
  return {
    host: imap.host, port: imap.port, secure: imap.security === 'tls',
    doSTARTTLS: imap.security === 'starttls' ? true : false,
    auth: { user: imap.username, pass: password }, logger: false,
    tls: { servername: isIP(imap.host) ? undefined : imap.host, rejectUnauthorized: imap.verifyCertificate, ...(imap.caFile ? { ca: readFileSync(imap.caFile) } : {}) },
    // This module explicitly breaks IDLE on its polling timer. ImapFlow's
    // separate maxIdleTime renewal loop can race that break and re-enter IDLE
    // while the consumer is waiting for the first idle() promise to finish.
    disableAutoIdle: true, socketTimeout: Math.max(60000, imap.pollIntervalMs * 2),
    connectionTimeout: 10000, greetingTimeout: 10000,
    maxLiteralSize: config.maxMessageBytes, maxResponseSize: config.maxMessageBytes + 65536, maxLineLength: 65536,
  }
}
const checkpointKey = (mailbox: string) => `imap:${mailbox}`
export function checkpointStart(store: Store, mailbox: string, validity: string, uidNext: number): number {
  const raw = store.meta(checkpointKey(mailbox))
  if (!raw) { store.setMeta(checkpointKey(mailbox), JSON.stringify({ validity, uid: uidNext - 1 })); return uidNext }
  const saved = JSON.parse(raw) as { validity: string; uid: number }
  if (saved.validity !== validity) { store.setMeta(checkpointKey(mailbox), JSON.stringify({ validity, uid: 0 })); return 1 }
  return saved.uid + 1
}
export async function persistFetched(store: Store, mailbox: string, validity: string, uid: number, raw: Uint8Array, maxBytes: number): Promise<void> {
  let messageId: string | undefined
  if (raw.byteLength <= maxBytes) {
    try { messageId = (await parseIncoming(raw, maxBytes)).messageId } catch {}
  }
  store.transaction(() => {
    if (raw.byteLength <= maxBytes) store.ingest(incomingIdentity(raw, messageId), Buffer.from(raw).toString('base64'))
    store.setMeta(checkpointKey(mailbox), JSON.stringify({ validity, uid }))
  })
}
export async function startImap(config: Config, password: string, store: Store, signal: AbortSignal, status: (value: string) => void): Promise<void> {
  let failures = 0
  while (!signal.aborted) {
    const client = new ImapFlow(imapOptions(config, password))
    client.on('error', () => { status('reconnecting') })
    // IDLE resolves when a subsequent command breaks it, not simply on EXISTS.
    // Wake it on new-mail notifications; otherwise the consumer would stay in
    // ImapFlow's internal IDLE renewal loop forever.
    client.on('exists', () => { if (client.idling) void client.noop().catch(() => {}) })
    const abort = () => client.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      status('connecting')
      await client.connect()
      await client.mailboxOpen(config.imap.mailbox)
      status('connected'); failures = 0
      while (!signal.aborted && client.usable) {
        const mailbox = client.mailbox
        if (!mailbox) throw new Error('IMAP mailbox unavailable')
        const validity = String(mailbox.uidValidity)
        const start = checkpointStart(store, config.imap.mailbox, validity, mailbox.uidNext)
        // EXISTS notifications need not include a fresh UIDNEXT. Always query
        // the UID range in a nonempty mailbox instead of trusting stale UIDNEXT.
        if (mailbox.exists > 0) {
          // Fetch metadata first to avoid requesting oversized MIME bodies.
          const metadata: { uid: number; size: number }[] = []
          for await (const message of client.fetch(`${start}:*`, { uid: true, size: true }, { uid: true })) {
            if (message.uid >= start) metadata.push({ uid: message.uid, size: message.size ?? Infinity })
          }
          metadata.sort((a, b) => a.uid - b.uid)
          for (const message of metadata) {
            if (signal.aborted) break
            if (message.size > config.maxMessageBytes) {
              store.setMeta(checkpointKey(config.imap.mailbox), JSON.stringify({ validity, uid: message.uid }))
              continue
            }
            const fetched = await client.fetchOne(message.uid, { source: true }, { uid: true })
            if (fetched && fetched.source) await persistFetched(store, config.imap.mailbox, validity, message.uid, fetched.source, config.maxMessageBytes)
          }
        }
        // ImapFlow uses IDLE when advertised, and its configured polling fallback
        // otherwise. Timeout ensures even quiet mailboxes get reconciled.
        if (client.capabilities.has('IDLE')) {
          const idle = client.idle()
          // Also break quiet IDLE periodically for reconciliation. If EXISTS
          // wakes it first, Promise.race avoids waiting the full polling period.
          const wake = new AbortController()
          const stopWake = () => wake.abort()
          signal.addEventListener('abort', stopWake, { once: true })
          try {
            await Promise.race([idle, sleep(config.imap.pollIntervalMs, wake.signal)])
            if (!signal.aborted && client.usable) await client.noop()
            await idle
          } finally { wake.abort(); signal.removeEventListener('abort', stopWake) }
        }
        else { await sleep(config.imap.pollIntervalMs, signal); if (!signal.aborted) await client.noop() }
      }
    } catch { if (!signal.aborted) status('reconnecting') }
    finally { signal.removeEventListener('abort', abort); client.close() }
    if (!signal.aborted) await sleep(Math.min(config.retry.maxMs, config.retry.initialMs * 2 ** Math.min(failures++, 10)), signal)
  }
  status('stopped')
}
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
