/** 模型网关类型（design 5.9）。 */

export type ModelRole = 'primary' | 'fast'

/** 思考强度；off 表示不传推理参数（design 5.9） */
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'

/** 供应商接入的 API 协议类型（design 5.9） */
export type ApiType = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

export interface ModelCapabilities {
  tools: boolean
  vision?: boolean
  /** 是否支持 reasoning_effort 参数（OpenAI 兼容协议） */
  reasoningEffort?: boolean
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
  apiType: ApiType
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
  | {
      role: 'assistant'
      content: string
      toolCalls?: ToolCall[]
      /** 思考内容；Anthropic 回传工具结果时需要带 signature 重放 */
      reasoning?: { text: string; signature?: string }
    }
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

export interface ChatRequestOptions {
  /** "providerId/modelName"；缺省用 defaults.primary */
  target?: string
  reasoningEffort?: ReasoningEffort
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string; signatureDelta?: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; stopReason: StopReason }
