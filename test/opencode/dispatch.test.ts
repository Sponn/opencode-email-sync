import { expect, test } from 'bun:test'
import { dispatch } from '../../src/opencode/dispatch'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
const job = { id: 'mail-a', route, text: 'Proceed', sender: 'me@example.com', messageId: 'msg_a', owner: 'adapter', status: 'queued' }
test('dispatch reconciles accepted messages and defers busy sessions', async () => {
  const gateway = { async messages() { return [{ info: { id: 'msg_a', role: 'user' }, parts: [] }] }, async busy() { return false }, async submit() { throw new Error('Must not replay accepted message') } }
  expect(await dispatch(gateway, job, true)).toBe('accepted')
  expect(await dispatch({ ...gateway, async messages() { return [] }, async busy() { return true } }, job, true)).toBe('queued')
  expect(await dispatch({ ...gateway, async messages() { throw new Error('offline') } }, job, true)).toBe('queued')
})
test('off cancels unsubmitted mail and reconciliation never replays an absent uncertain job', async () => {
  const gateway = { async messages() { return [] }, async busy() { return false }, async submit() { throw new Error('Must not submit') } }
  expect(await dispatch(gateway, job, false)).toBe('canceled')
  expect(await dispatch(gateway, { ...job, status: 'reconcile' }, true)).toBe('uncertain')
})
test('fresh prompt preserves authored text, message ID and user selection', async () => {
  let submitted: unknown
  const gateway = {
    async messages() { return [{ info: { id: 'msg_old', role: 'user', agent: 'plan', model: { providerID: 'provider', modelID: 'model', variant: 'high' } }, parts: [{ type: 'text', text: 'Old' }] }] },
    async busy() { return false }, async submit(input: unknown) { submitted = input },
  }
  expect(await dispatch(gateway, job, true)).toBe('accepted')
  expect(submitted).toEqual({ messageID: 'msg_a', agent: 'plan', model: { providerID: 'provider', modelID: 'model' }, variant: 'high', parts: [{ type: 'text', text: 'Proceed' }, { type: 'text', text: '[Email reply from me@example.com]', synthetic: true }] })
})
