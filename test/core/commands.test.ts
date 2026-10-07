import { expect, test } from 'bun:test'
import { parseCommand } from '../../src/core/commands'

test('the identical shell-mode syntax controls all interfaces', () => {
  for (const action of ['on', 'off', 'status'] as const) {
    expect(parseCommand(`!opencode-email-sync session ${action}`)).toEqual({ kind: 'command', action })
  }
  expect(parseCommand('  !OPENCODE-EMAIL-SYNC SESSION OFF  ')).toEqual({ kind: 'command', action: 'off' })
})
test('command-like email cannot introduce shell arguments or mixed prose', () => {
  for (const text of ['!opencode-email-sync session off; rm -rf /', '!opencode-email-sync session on\nDo something', '!opencode-email-sync session maybe', 'Please stop syncing.\n!opencode-email-sync session off']) {
    expect(parseCommand(text).kind).toBe('invalid')
  }
  expect(parseCommand('Please change the heading')).toEqual({ kind: 'text', text: 'Please change the heading' })
  expect(parseCommand('!ls')).toEqual({ kind: 'text', text: '!ls' })
})
