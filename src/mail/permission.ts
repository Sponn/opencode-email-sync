import type { PermissionRequest } from '../core/types'

export const permissionUsage = 'Reply with exactly one of these commands:\n!opencode-email-sync permission once\n!opencode-email-sync permission reject\n!opencode-email-sync permission always'
function block(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
  const fence = '`'.repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), match => match[0].length + 1)))
  return `${fence}json\n${text}\n${fence}`
}
export function permissionText(request: PermissionRequest): string {
  return `## Permission required\n\nOpenCode is paused until this permission request is answered.\n\nRequest: ${request.id}\n\nPermission and affected actions:\n\n${block({ permission: request.permission, targetSessionID: request.sessionID, patterns: request.patterns, metadata: request.metadata, tool: request.tool })}\n\n## Your reply options\n\n- **Allow once:** approve only this request.\n\n\`!opencode-email-sync permission once\`\n\n- **Reject:** deny this request.\n\n\`!opencode-email-sync permission reject\`\n\n- **Allow matching actions:** use OpenCode's always option for matching actions, with the same scope as its UI.\n\n\`!opencode-email-sync permission always\`\n\nAlways-approval patterns:\n\n${block(request.always)}\n\nSend one command by replying to this email. Its thread identifies this exact request; an old reply cannot approve a different request. Do not add other instructions to the command.\n\nOpenCode does not accept shell commands in a busy/paused session. To answer from shell mode, open another session in the same project and append this request ID, for example:\n\n\`!opencode-email-sync permission once ${request.id}\``
}
