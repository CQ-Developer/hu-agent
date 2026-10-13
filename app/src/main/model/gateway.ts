/** 模型网关：按 primary/fast 角色路由到 provider，统一流式事件与重试（design 5.2/5.9）。 */

import { ModelError, classifyThrown } from './errors'
import { streamOpenAiChat } from './providers/openai'
import type { LlmMessage, ModelEntry, ModelRole, ModelSettings, ProviderConfig, StreamEvent, ToolDefinitionForModel } from './types'

export interface GatewayDeps {
  getSettings(): ModelSettings
  getSecret(ref: string): string | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class ModelGateway {
  constructor(private readonly deps: GatewayDeps) {}

  resolve(role: ModelRole): { provider: ProviderConfig; model: ModelEntry } {
    const settings = this.deps.getSettings()
    const target = role === 'fast' ? (settings.defaults.fast ?? settings.defaults.primary) : settings.defaults.primary
    const slash = target.indexOf('/')
    const providerId = slash >= 0 ? target.slice(0, slash) : ''
    const modelName = slash >= 0 ? target.slice(slash + 1) : target

    const provider =
      settings.providers.find((item) => item.id === providerId) ??
      settings.providers.find((item) => item.models.some((model) => model.name === modelName))
    if (!provider) throw new ModelError('bad_request', `未找到模型配置：${target}`)

    const model = provider.models.find((item) => item.name === modelName) ?? provider.models[0]
    if (!model) throw new ModelError('bad_request', `供应商 ${provider.id} 未配置模型`)
    return { provider, model }
  }

  async *chat(
    role: ModelRole,
    messages: LlmMessage[],
    tools: ToolDefinitionForModel[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const { provider, model } = this.resolve(role)
    const apiKey = provider.apiKeyRef ? this.deps.getSecret(provider.apiKeyRef) : null

    let attempt = 0
    for (;;) {
      let receivedAny = false
      try {
        const stream = streamOpenAiChat({
          baseUrl: provider.baseUrl,
          model: model.name,
          messages,
          tools,
          apiKey,
          signal,
          maxOutputTokens: model.capabilities.maxOutput,
        })
        for await (const event of stream) {
          receivedAny = true
          yield event
        }
        return
      } catch (error) {
        const modelError = classifyThrown(error)
        if (!modelError.retryable || receivedAny || attempt >= 2) throw modelError
        attempt += 1
        await sleep(1000 * attempt * attempt)
      }
    }
  }
}
