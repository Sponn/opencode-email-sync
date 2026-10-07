import type { Plugin } from '@opencode-ai/plugin'
import { defaultConfigPath } from './core/config'
import { createAdapter } from './opencode/adapter'

export default (async (input, options) => {
  const configPath = typeof options?.configPath === 'string' ? options.configPath : defaultConfigPath()
  return createAdapter(input, configPath)
}) satisfies Plugin
