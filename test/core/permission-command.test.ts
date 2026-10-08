import { expect, test } from 'bun:test'
import { parseCommand } from '../../src/core/commands'
test('permission reply commands are exact and may explicitly identify a request', () => {
  for (const action of ['once', 'reject', 'always'] as const) {
    expect(parseCommand(`!opencode-email-sync permission ${action}`)).toEqual({ kind: 'permission', action })
    expect(parseCommand(`!opencode-email-sync permission ${action} per_123`)).toEqual({ kind: 'permission', action, requestId: 'per_123' })
  }
  for (const text of ['!opencode-email-sync permission yes', '!opencode-email-sync permission once per_a per_b', 'Please approve\n!opencode-email-sync permission always', '!opencode-email-sync permission once; anything']) expect(parseCommand(text).kind).toBe('invalid')
})
