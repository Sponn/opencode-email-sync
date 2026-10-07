import { simpleParser } from 'mailparser'
import sanitizeHtml from 'sanitize-html'
import { normalizeAddress, type Config } from '../core/config'
import type { Thread } from '../core/types'

export interface ParsedMail { from: string[]; references: string[]; messageId?: string; text: string; html: string; headers: Map<string, unknown>; headerLines: readonly { key: string; line: string }[] }
export function parseIncoming(raw: Uint8Array, maxBytes: number): Promise<ParsedMail> {
  if (raw.byteLength > maxBytes) throw new Error('Incoming message exceeds maxMessageBytes')
  return simpleParser(Buffer.from(raw), { skipHtmlToText: true, skipTextToHtml: true }).then(mail => ({
    from: mail.headerLines.filter(header => header.key === 'from').length === 1 ? (mail.from?.value || []).map(address => normalizeAddress(address.address || '')) : [],
    references: [...new Set([mail.inReplyTo, ...(Array.isArray(mail.references) ? mail.references : mail.references ? [mail.references] : [])].filter((value): value is string => !!value))],
    messageId: mail.messageId, text: mail.text || '', html: typeof mail.html === 'string' ? mail.html : '',
    headers: mail.headers, headerLines: mail.headerLines,
  }))
}
export function authorize(mail: ParsedMail, config: Config, thread: Thread | null): boolean {
  if (mail.from.length !== 1 || !thread) return false
  const sender = mail.from[0]
  if (sender === normalizeAddress(config.account.address) || !config.recipients.includes(sender) || thread.recipient !== sender) return false
  const auto = String(mail.headers.get('auto-submitted') || '').toLowerCase()
  if ((auto && auto !== 'no') || mail.headers.has('x-opencode-email-sync') || /bulk|list|junk/i.test(String(mail.headers.get('precedence') || ''))) return false
  const trusted = config.senderAuthentication?.trustedAuthservIds
  if (trusted) {
    // Only evaluate the receiving server's topmost Authentication-Results. An
    // attacker may append forged copies underneath a genuine failure result.
    const line = mail.headerLines.find(header => header.key === 'authentication-results')?.line.replace(/\r?\n\s+/g, ' ')
    if (!line) return false
    const value = line.replace(/^authentication-results:\s*/i, '')
    const authserv = value.split(';')[0].trim().split(/\s+/)[0]
    if (!trusted.includes(authserv)) return false
    const dmarc = /(?:^|;)\s*dmarc=pass\b([^;]*)/i.exec(value)
    const domain = /header\.from\s*=\s*"?([^\s;"()]+)/i.exec(dmarc?.[1] || '')?.[1]
    if (!domain || domain.toLowerCase() !== sender.slice(sender.lastIndexOf('@') + 1)) return false
  }
  return true
}
export function extractReply(mail: ParsedMail): { kind: 'text'; text: string } | { kind: 'empty' | 'ambiguous' } {
  let text = mail.text
  if (!text && mail.html) {
    // sanitize-html uses an HTML parser, so exclusion removes complete nested
    // quote subtrees rather than stopping at an inner closing tag.
    const html = sanitizeHtml(mail.html, {
      allowedTags: ['div', 'p', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote'],
      allowedAttributes: { '*': ['class', 'id'] },
      exclusiveFilter: frame => frame.tag === 'blockquote' || /(?:gmail_quote|yahoo_quoted)/i.test(frame.attribs.class || ''),
    })
    text = sanitizeHtml(html.replace(/<\/(?:div|p|li|h[1-6])>/gi, '\n').replace(/<br\s*\/?>/gi, '\n'), { allowedTags: [], allowedAttributes: {} })
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const delimiter = lines.findIndex(line => line.trim() === '--- end reply ---')
  if (delimiter >= 0) text = lines.slice(0, delimiter).join('\n')
  else {
    const quote = lines.findIndex((line, index) => /^\s*>/.test(line) || (/^\s*On\s+/i.test(line) && lines.slice(index, index + 8).some(candidate => /\bwrote:\s*$/i.test(candidate))) || /^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(line) || /^\s*From:\s*.+@/i.test(line) || /^--\s*$/.test(line) || /^Sent from my (iPhone|iPad|Android)/i.test(line) || (line.trim() === '________________________________' && index > 0))
    text = (quote < 0 ? lines : lines.slice(0, quote)).join('\n')
    if (/\bOn .+\n.+wrote:/i.test(text) || /Original Message|Begin forwarded message/i.test(text)) return { kind: 'ambiguous' }
  }
  text = text.trim()
  return text ? { kind: 'text', text } : { kind: 'empty' }
}
