export type Action = 'on' | 'off' | 'status'
export type Command = { kind: 'command'; action: Action } | { kind: 'invalid' } | { kind: 'text'; text: string }
export function parseCommand(text: string): Command {
  const trimmed = text.trim()
  const match = /^!opencode-email-sync\s+session\s+(on|off|status)$/i.exec(trimmed)
  if (match) return { kind: 'command', action: match[1].toLowerCase() as Action }
  if (/(?:^|\n)\s*!opencode-email-sync\b/i.test(trimmed)) return { kind: 'invalid' }
  return { kind: 'text', text: trimmed }
}
