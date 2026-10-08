export type Action = 'on' | 'off' | 'status'
export type PermissionAction = 'once' | 'always' | 'reject'
export type Command = { kind: 'command'; action: Action } | { kind: 'permission'; action: PermissionAction; requestId?: string } | { kind: 'invalid' } | { kind: 'text'; text: string }
export function parseCommand(text: string): Command {
  const trimmed = text.trim()
  const match = /^!opencode-email-sync\s+session\s+(on|off|status)$/i.exec(trimmed)
  if (match) return { kind: 'command', action: match[1].toLowerCase() as Action }
  const permission = /^!opencode-email-sync\s+permission\s+(once|always|reject)(?:\s+(per_[\w-]+))?$/i.exec(trimmed)
  if (permission) return { kind: 'permission', action: permission[1].toLowerCase() as PermissionAction, ...(permission[2] ? { requestId: permission[2] } : {}) }
  if (/(?:^|\n)\s*!opencode-email-sync\b/i.test(trimmed)) return { kind: 'invalid' }
  return { kind: 'text', text: trimmed }
}
