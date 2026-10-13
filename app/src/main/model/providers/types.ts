/** 各 provider 适配器的公共入参。 */

import type { LlmMessage, ReasoningEffort, ToolDefinitionForModel } from '../types'

export interface ProviderStreamOptions {
  baseUrl: string
  model: string
  messages: LlmMessage[]
  tools?: ToolDefinitionForModel[]
  apiKey?: string | null
  signal?: AbortSignal
  maxOutputTokens?: number
  /** 仅当模型声明支持时由网关传入 */
  reasoningEffort?: Exclude<ReasoningEffort, 'off'>
}
