import type { PromptJob } from '../core/types'
export interface HistoryMessage { info: { id: string; role: string; agent?: string; model?: { providerID: string; modelID: string; variant?: string }; variant?: string }; parts: { type: string; synthetic?: boolean }[] }
export interface PromptInput { messageID: string; agent?: string; model?: { providerID: string; modelID: string }; variant?: string; parts: { type: 'text'; text: string; synthetic?: boolean }[] }
export class SessionDeletedError extends Error {}
export interface Gateway { messages(): Promise<HistoryMessage[]>; busy(): Promise<boolean>; authorize?(): Promise<boolean>; submit(input: PromptInput): Promise<void> }
export async function dispatch(gateway: Gateway, job: PromptJob, enabled: boolean): Promise<'accepted' | 'queued' | 'uncertain' | 'canceled' | 'failed'> {
  let submitting = false
  try {
    const history = await gateway.messages()
    if (history.some(message => message.info.id === job.messageId)) return 'accepted'
    if (job.status === 'reconcile') return 'uncertain'
    if (!enabled) return 'canceled'
    if (await gateway.busy()) return 'queued'
    const user = history.findLast(message => message.info.role === 'user' && message.parts.some(part => part.type === 'text' && !part.synthetic))?.info
    const model = user?.model
    if (gateway.authorize && !(await gateway.authorize())) return 'canceled'
    submitting = true
    await gateway.submit({
      messageID: job.messageId,
      ...(user?.agent ? { agent: user.agent } : {}),
      ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
      ...(model?.variant || user?.variant ? { variant: model?.variant || user?.variant } : {}),
      parts: [{ type: 'text', text: job.text }, { type: 'text', text: `[Email reply from ${job.sender}]`, synthetic: true }],
    })
    return 'accepted'
  } catch (error) {
    if (error instanceof SessionDeletedError) return 'failed'
    return submitting || job.status === 'reconcile' ? 'uncertain' : 'queued'
  }
}
