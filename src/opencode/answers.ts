import type { Answer, Route } from '../core/types'
// Narrow structural boundary also accepts matching SDK message/part unions.
export interface MessageRecord { info: { id: string; role: string; parentID?: string; summary?: boolean; finish?: string; error?: unknown; time?: { completed?: number } }; parts: { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[] }
export function completedAnswers(messages: MessageRecord[], route: Route, project: string, title: string): Answer[] {
  const results: Answer[] = []
  for (const user of messages.filter(message => message.info.role === 'user')) {
    if (!user.parts.some(part => part.type === 'text' && !part.synthetic && !part.ignored && !!part.text?.trim())) continue
    if (user.parts.some(part => part.type === 'compaction' || part.type === 'subtask')) continue
    const assistant = messages.filter(message => message.info.role === 'assistant' && message.info.parentID === user.info.id && !message.info.summary)
    const last = assistant.at(-1)
    if (!last?.info.time?.completed || !last.info.finish || ['tool-calls', 'unknown'].includes(last.info.finish) || last.info.error) continue
    const text = assistant.flatMap(message => message.parts.filter(part => part.type === 'text' && !part.synthetic && !part.ignored).map(part => part.text || '')).filter(Boolean).join('\n\n')
    if (text.trim()) results.push({ route, turnId: user.info.id, text, project, title })
  }
  return results
}
export function shellContext(route: Route, configPath: string): Record<string, string> { return { OPENCODE_EMAIL_ROUTE: JSON.stringify(route), OPENCODE_EMAIL_CONFIG: configPath } }
