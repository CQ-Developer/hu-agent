/** 模型网关：按会话选择的模型路由到 provider 适配器，统一流式事件与重试（design 5.2/5.9）。 */

import { ModelError, classifyThrown } from './errors'
import { streamAnthropicMessages } from './providers/anthropic'
import { streamOpenAiChat } from './providers/openai'
import { streamOpenAiResponses } from './providers/openai-responses'
import type { ProviderStreamOptions } from './providers/types'
import type {
  ApiType,
  ChatRequestOptions,
  LlmMessage,
  ModelEntry,
  ModelSettings,
  ProviderConfig,
  StreamEvent,
  ToolDefinitionForModel,
} from './types'

export interface GatewayDeps {
  getSettings(): ModelSettings
  getSecret(ref: string): string | null
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type StreamFn = (options: ProviderStreamOptions) => AsyncIterable<StreamEvent>

function adapterFor(apiType: ApiType): StreamFn {
  switch (apiType) {
    case 'openai-responses':
      return streamOpenAiResponses
    case 'anthropic-messages':
      return streamAnthropicMessages
    case 'openai-chat':
    default:
      return streamOpenAiChat
  }
}

export class ModelGateway {
  constructor(private readonly deps: GatewayDeps) {}

  /** target 形如 "providerId/modelName"；缺省用 defaults.primary。 */
  resolve(target?: string): { provider: ProviderConfig; model: ModelEntry } {
    const settings = this.deps.getSettings()
    const wanted = target ?? settings.defaults.primary
    const slash = wanted.indexOf('/')
    const providerId = slash >= 0 ? wanted.slice(0, slash) : ''
    const modelName = slash >= 0 ? wanted.slice(slash + 1) : wanted

    const provider =
      settings.providers.find((item) => item.id === providerId) ??
      settings.providers.find((item) => item.models.some((model) => model.name === modelName))
    if (!provider) throw new ModelError('bad_request', `未找到模型配置：${wanted}`)

    const model = provider.models.find((item) => item.name === modelName) ?? provider.models[0]
    if (!model) throw new ModelError('bad_request', `供应商 ${provider.id} 未配置模型`)
    return { provider, model }
  }

  async *chat(
    request: ChatRequestOptions,
    messages: LlmMessage[],
    tools: ToolDefinitionForModel[],
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    const { provider, model } = this.resolve(request.target)
    const apiKey = provider.apiKeyRef ? this.deps.getSecret(provider.apiKeyRef) : null
    const effort =
      model.capabilities.reasoningEffort && request.reasoningEffort && request.reasoningEffort !== 'off'
        ? request.reasoningEffort
        : undefined
    const streamFn = adapterFor(provider.apiType)

    let attempt = 0
    for (;;) {
      let receivedAny = false
      try {
        const stream = streamFn({
          baseUrl: provider.baseUrl,
          model: model.name,
          messages,
          tools,
          apiKey,
          signal,
          maxOutputTokens: model.capabilities.maxOutput,
          reasoningEffort: effort,
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
