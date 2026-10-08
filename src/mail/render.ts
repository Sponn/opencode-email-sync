import { marked } from 'marked'
import sanitizeHtml from 'sanitize-html'
import type { Delivery } from '../core/types'
import type { Config } from '../core/config'
import { permissionUsage } from './permission'

const footer = 'Reply above the quoted message to continue this session. Controls (one line only):\n!opencode-email-sync session on\n!opencode-email-sync session off\n!opencode-email-sync session status'
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const header = (text: string, limit: number) => text.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, limit)
export function renderMail(delivery: Delivery, config: Config) {
  const content = sanitizeHtml(marked.parse(delivery.text, { async: false }), {
    allowedTags: ['p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
    allowedAttributes: { a: ['href', 'title'], '*': ['style'] }, allowedSchemes: ['https', 'http', 'mailto'],
    transformTags: {
      pre: () => ({ tagName: 'pre', attribs: { style: 'background:#f3f4f6;padding:12px;white-space:pre-wrap;font-family:monospace' } }),
      code: () => ({ tagName: 'code', attribs: { style: 'font-family:monospace' } }),
      td: () => ({ tagName: 'td', attribs: { style: 'border:1px solid #ddd;padding:6px' } }),
      th: () => ({ tagName: 'th', attribs: { style: 'border:1px solid #ddd;padding:6px' } }),
    }, allowedStyles: { '*': { background: [/^#f3f4f6$/], padding: [/^(6|12)px$/], 'white-space': [/^pre-wrap$/], 'font-family': [/^monospace$/], border: [/^1px solid #ddd$/] } },
  })
  const context = `${delivery.project} — ${delivery.title}\n${delivery.route.directory}\nSession: ${delivery.route.sessionId}`
  const instructions = delivery.permissionKey ? `${permissionUsage}\nSession controls: !opencode-email-sync session on|off|status` : footer
  return {
    from: { name: config.account.displayName || 'OpenCode', address: config.account.address }, to: delivery.recipient,
    replyTo: config.account.address, messageId: delivery.messageId,
    subject: `[${header(delivery.project, 60)}] ${delivery.permissionKey && !delivery.control ? 'Permission required: ' : ''}${header(delivery.title, 120)} [${header(delivery.route.sessionId, 100)}]`,
    text: `${context}\n\n${delivery.text}\n\n---\n${instructions}`,
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#222"><p>${escape(context).replace(/\n/g, '<br>')}</p><hr>${content}<hr><p style="font-size:12px;color:#666">${escape(instructions).replace(/\n/g, '<br>')}</p></div>`,
    ...(delivery.references ? { inReplyTo: delivery.references, references: delivery.references } : {}),
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All', 'X-OpenCode-Email-Sync': '1' },
  }
}
