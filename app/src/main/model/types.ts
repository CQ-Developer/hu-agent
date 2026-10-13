/** 模型网关类型（design 5.9）。 */

export type ModelRole = 'primary' | 'fast'

export interface ModelCapabilities {
  tools: boolean
  vision?: boolean
  contextWindow: number
  maxOutput?: number
}

export interface ModelEntry {
  name: string
  roles?: ModelRole[]
  capabilities: ModelCapabilities
}

export interface ProviderConfig {
  id: string
  type: 'openai-compatible'
  baseUrl: string
  /** 密钥引用名（实际值存在 safeStorage 加密文件中），无鉴权的本地服务为 null */
  apiKeyRef?: string | null
  models: ModelEntry[]
}

export interface ModelDefaults {
  /** "providerId/modelName" */
  primary: string
  fast?: string
}

export interface ModelSettings {
  providers: ProviderConfig[]
  defaults: ModelDefaults
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

/** 发送给模型的统一消息结构（由 provider 适配为各自协议）。 */
export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export interface ToolDefinitionForModel {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type StopReason = 'stop' | 'tool_use' | 'length'

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; stopReason: StopReason }
