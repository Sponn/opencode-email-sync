import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../../src/state/database'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
test('restart holds uncertain SMTP outcomes and reconciles prompt acceptance before replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'email-recovery-'))
  const path = join(directory, 'state.sqlite')
  try {
    const first = new Store(path, ['me@example.com'])
    first.registerSession(route, 'P', 'S'); first.baseline(route, ['old'])
    first.setPolicy(route, false); first.setPolicy(route, true)
    first.answer({ route, turnId: 'new', text: 'Done', project: 'P', title: 'S' })
    const delivery = first.deliveries()[0]
    first.startDelivery(delivery)
    first.enqueue(route, 'reply', 'Continue', 'me@example.com')
    const prompt = first.claim(route, 'old-adapter')!
    expect(first.beginDispatch(prompt.id, 'old-adapter')).toBe(true)
    first.close()
    const second = new Store(path, ['me@example.com'])
    expect(second.policy(route)).toBe(true)
    expect(second.session(route)?.baseline).toEqual(['old'])
    expect(second.deliveries()).toEqual([])
    expect(second.status().uncertain).toEqual([{ id: delivery.id, kind: 'delivery' }])
    expect(second.claim(route, 'new-adapter')?.status).toBe('reconcile')
    second.ack(prompt.id, 'new-adapter', 'accepted')
    second.enqueue(route, 'reply', 'Duplicate', 'me@example.com')
    expect(second.claim(route, 'third')).toBeNull()
    second.close()
  } finally { await rm(directory, { recursive: true, force: true }) }
})
