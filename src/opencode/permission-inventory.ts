import { resolve } from 'node:path'
import type { Session } from '@opencode-ai/sdk'
import type { PermissionRequest } from '../core/types'

// Build the full snapshot before publishing any route. A failed read is not an
// empty inventory and must never close requests that are still live remotely.
export async function rootPermissions(requests: PermissionRequest[], directory: string, getSession: (id: string) => Promise<Session>) {
  const grouped = new Map<string, { session: Session; requests: PermissionRequest[] }>()
  for (const request of requests) {
    let session = await getSession(request.sessionID)
    const visited = new Set<string>()
    while (session.parentID) {
      if (visited.has(session.id)) throw new Error('Session parent cycle')
      visited.add(session.id)
      session = await getSession(session.parentID)
    }
    if (resolve(session.directory) !== resolve(directory)) continue
    const group = grouped.get(session.id) || { session, requests: [] }
    group.requests.push(request); grouped.set(session.id, group)
  }
  return grouped
}
