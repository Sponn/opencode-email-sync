import { expect, test } from 'bun:test'
import { completedAnswers, shellContext } from '../../src/opencode/answers'
const route = { instanceId: 'local', projectId: 'p', directory: '/project', sessionId: 'ses_a' }
test('answer detection excludes reasoning, tool traces, synthetic turns and unfinished turns', () => {
  const history: any[] = [
    { info: { id: 'u1', role: 'user' }, parts: [{ type: 'text', text: 'Change it' }] },
    { info: { id: 'a1', role: 'assistant', parentID: 'u1', finish: 'tool-calls', time: { completed: 1 } }, parts: [{ type: 'text', text: 'Working' }, { type: 'reasoning', text: 'secret' }] },
    { info: { id: 'a2', role: 'assistant', parentID: 'u1', finish: 'stop', time: { completed: 2 } }, parts: [{ type: 'text', text: 'Done' }, { type: 'tool', state: { output: 'trace' } }] },
    { info: { id: 'u2', role: 'user' }, parts: [{ type: 'text', text: 'More' }] },
    { info: { id: 'a3', role: 'assistant', parentID: 'u2', time: {} }, parts: [{ type: 'text', text: 'Incomplete' }] },
  ]
  expect(completedAnswers(history, route, 'Project', 'Session')).toEqual([{ route, turnId: 'u1', text: 'Working\n\nDone', project: 'Project', title: 'Session' }])
  history[0].parts[0].synthetic = true
  expect(completedAnswers(history, route, 'Project', 'Session')).toEqual([])
})
test('shell context includes route for CLI but no mail credentials', () => {
  const env = shellContext(route, '/config/mail.json')
  expect(JSON.parse(env.OPENCODE_EMAIL_ROUTE)).toEqual(route)
  expect(env.OPENCODE_EMAIL_CONFIG).toBe('/config/mail.json')
  expect(Object.keys(env)).toHaveLength(2)
})
