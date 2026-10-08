import { expect, test } from 'bun:test'
import { rootPermissions } from '../../src/opencode/permission-inventory'
import type { Session } from '@opencode-ai/sdk'
const request = { id: 'per_a', sessionID: 'ses_child', permission: 'bash', patterns: ['printf'], always: ['printf'], metadata: {} }
test('failed child or ancestor lookup rejects an incomplete snapshot rather than expiring its root permissions', async () => {
  const child = { id: 'ses_child', directory: '/project', parentID: 'ses_root' } as Session
  await expect(rootPermissions([request], '/project', async id => { if (id === child.id) return child; throw new Error('Transient lookup error') })).rejects.toThrow('Transient lookup error')
  await expect(rootPermissions([request], '/project', async () => { throw new Error('Unavailable child') })).rejects.toThrow('Unavailable child')
  const grouped = await rootPermissions([request], '/project', async id => id === child.id ? child : { id: 'ses_root', directory: '/project' } as Session)
  expect(grouped.get('ses_root')?.requests).toEqual([request])
})
