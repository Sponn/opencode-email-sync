import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const connection = z.object({
  host: z.string().min(1), port: z.number().int().min(1).max(65535), username: z.string().min(1),
  passwordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), security: z.enum(['tls', 'starttls', 'plain']).default('tls'),
  verifyCertificate: z.boolean().default(true), caFile: z.string().optional(),
})
const schema = z.object({
  account: z.object({ address: z.email(), displayName: z.string().optional() }), recipients: z.array(z.email()).min(1),
  smtp: connection,
  imap: connection.extend({ mailbox: z.string().default('INBOX'), pollIntervalMs: z.number().int().min(100).default(30000) }),
  worker: z.object({
    port: z.number().int().min(1).max(65535).default(4197), stateDirectory: z.string().optional(),
    autoStart: z.boolean().default(false), envFile: z.string().min(1).optional(), bunPath: z.string().min(1).optional(),
    binDirectory: z.string().min(1).optional(), restartDelayMs: z.number().int().min(100).default(10000),
  }).optional(),
  retry: z.object({ initialMs: z.number().int().positive().default(1000), maxMs: z.number().int().positive().default(60000) }).default({ initialMs: 1000, maxMs: 60000 }),
  maxMessageBytes: z.number().int().positive().default(1048576),
  senderAuthentication: z.object({ trustedAuthservIds: z.array(z.string().min(1)).min(1) }).optional(),
})
export type Config = Omit<z.infer<typeof schema>, 'worker'> & { worker: { port: number; stateDirectory: string; autoStart: boolean; envFile?: string; bunPath?: string; binDirectory: string; restartDelayMs: number } }
export function defaultConfigPath(): string { return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode-email-sync/config.json') }
export function validateConfig(input: unknown, configPath = defaultConfigPath()): Config {
  const result = schema.parse(input)
  if (result.retry.maxMs < result.retry.initialMs) throw new Error('retry.maxMs must be at least retry.initialMs')
  if (result.recipients.some(address => normalizeAddress(address) === normalizeAddress(result.account.address))) throw new Error('The account address cannot be a recipient')
  const stateDirectory = result.worker?.stateDirectory || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'opencode-email-sync')
  const base = dirname(resolve(configPath))
  const relative = (path: string) => resolve(base, path.replace(/^~\//, `${homedir()}/`))
  return {
    ...result, recipients: [...new Set(result.recipients.map(normalizeAddress))],
    worker: {
      port: result.worker?.port || 4197, stateDirectory: resolve(stateDirectory.replace(/^~\//, `${homedir()}/`)),
      autoStart: result.worker?.autoStart ?? false, restartDelayMs: result.worker?.restartDelayMs ?? 10000,
      binDirectory: relative(result.worker?.binDirectory || 'bin'),
      ...(result.worker?.envFile ? { envFile: relative(result.worker.envFile) } : {}),
      ...(result.worker?.bunPath ? { bunPath: relative(result.worker.bunPath) } : {}),
    },
  }
}
export function loadConfig(path = defaultConfigPath()): Config { return validateConfig(JSON.parse(readFileSync(path, 'utf8')), path) }
export function resolveCredentials(config: Config, env: Record<string, string | undefined>): { smtp: string; imap: string } {
  const get = (name: string) => { const value = env[name]; if (!value) throw new Error(`Missing credential environment variable: ${name}`); return value }
  return { smtp: get(config.smtp.passwordEnv), imap: get(config.imap.passwordEnv) }
}
export function normalizeAddress(address: string): string {
  const at = address.lastIndexOf('@')
  return `${address.slice(0, at)}@${address.slice(at + 1).toLowerCase()}`
}
