/** 模型设置类型（design 5.9）：provider 接入协议与设置结构。
 *
 * 运行时的模型目录归 pi：`models.json` 由 `model/pi_config.ts` 投影、`model/pi_runtime.ts` 注册进
 * pi-ai 的 models 集合。本文件只保留设置页与配置层共用的形状（会话消息/事件等旧形状已随 R1/R5 删除）。
 */

/** 供应商接入的 API 协议类型 */
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
  /** 该模型承担的角色（界面展示与默认值推导用） */
  roles?: ('primary' | 'fast')[]
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
