import nodemailer from 'nodemailer'
import type Mail from 'nodemailer/lib/mailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { readFileSync } from 'node:fs'
import type { Config } from '../core/config'
export interface MailSender { send(mail: Mail.Options): Promise<'sent' | 'uncertain'>; close(): Promise<void> }
export function createSmtp(config: Config, credentials: { smtp: string; imap: string }): MailSender {
  const smtp = config.smtp
  const transports = new Set<ReturnType<typeof nodemailer.createTransport>>()
  const options: SMTPTransport.Options = {
    host: smtp.host, port: smtp.port, secure: smtp.security === 'tls',
    requireTLS: smtp.security === 'starttls', ignoreTLS: smtp.security === 'plain',
    auth: { user: smtp.username, pass: credentials.smtp },
    tls: { rejectUnauthorized: smtp.verifyCertificate, ...(smtp.caFile ? { ca: readFileSync(smtp.caFile) } : {}) },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    debug: false,
  }
  return {
    async send(mail) {
      let dataStarted = false
      const discard = () => {}
      const transport = nodemailer.createTransport({
        ...options, transactionLog: true,
        // Observe only the SMTP phase; never emit or retain transaction text,
        // mail content, addresses, or credential commands.
        logger: { trace: discard, info: discard, warn: discard, error: discard, fatal: discard, debug(meta: { tnx?: string }, message: unknown) { if (meta.tnx === 'client' && message === 'DATA') dataStarted = true } },
      } as SMTPTransport.Options & { transactionLog: boolean })
      transports.add(transport)
      try { await transport.sendMail(mail); return 'sent' }
      catch (error) {
        const detail = error as { code?: string; command?: string; responseCode?: number }
        // A disconnect after DATA might be after server acceptance.
        if (!detail.responseCode && dataStarted) return 'uncertain'
        const safe = new Error(`SMTP delivery failed (${detail.code || 'transport'})`) as Error & { permanent: boolean }
        safe.permanent = !!detail.responseCode && detail.responseCode >= 500
        throw safe
      } finally { transport.close(); transports.delete(transport) }
    }, async close() { for (const transport of transports) transport.close() },
  }
}
