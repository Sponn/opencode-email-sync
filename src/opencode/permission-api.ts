import { z } from 'zod'
import type { PluginInput } from '@opencode-ai/plugin'
import type { PermissionRequest } from '../core/types'
import type { PermissionAction } from '../core/commands'

export const permissionRequestSchema = z.object({
  id: z.string().regex(/^per_[\w-]+$/), sessionID: z.string().regex(/^ses_[\w-]+$/),
  permission: z.string(), patterns: z.array(z.string()), always: z.array(z.string()), metadata: z.record(z.string(), z.unknown()),
  tool: z.object({ messageID: z.string(), callID: z.string() }).optional(),
})
export interface PermissionGateway {
  list(): Promise<PermissionRequest[]>
  reply(sessionId: string, requestId: string, action: PermissionAction): Promise<'accepted' | 'stale'>
}
export function permissionGateway(input: PluginInput): PermissionGateway {
  return {
    async list() {
      // The pinned v1 plugin SDK does not expose permission.list, but its
      // generated methods spread request options into the same authenticated
      // HTTP client. Override only the URL, retaining in-process/TUI fetch and
      // server auth rather than constructing an unauthenticated second client.
      const options = { url: '/permission', query: { directory: input.directory } }
      const result = await input.client.session.status(options)
      if (result.error || !result.data) throw new Error('Could not read pending permission requests')
      return z.array(permissionRequestSchema).parse(result.data)
    },
    async reply(sessionId, requestId, action) {
      const result = await input.client.postSessionIdPermissionsPermissionId({ path: { id: sessionId, permissionID: requestId }, body: { response: action } })
      if (result.response.status === 404) return 'stale'
      if (result.error || result.data !== true) throw new Error('Permission decision acceptance could not be confirmed')
      return 'accepted'
    },
  }
}
