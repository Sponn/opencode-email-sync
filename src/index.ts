import type { Plugin } from '@opencode-ai/plugin'
import { defaultConfigPath } from './core/config'
import { createAdapter } from './opencode/adapter'
import { ensureWorker } from './worker/bootstrap'

export default (async (input, options) => {
  const configPath = typeof options?.configPath === 'string' ? options.configPath : defaultConfigPath()
  await ensureWorker(configPath)
  return createAdapter(input, configPath)
}) satisfies Plugin
