/**
 * pi 运行时装配（P1.2-d）：把配置层（`pi-config`）与 pi-ai 组装成循环需要的两个能力接口。
 *
 * 这是"切掉旧网关"的最后一层——`pi-loop.ts` 只认 `ModelResolver` / `HistorySummarizer`，
 * 由本模块提供 pi 实现，于是旧 `ModelGateway`、旧 provider、SSE 解析都可以删除。
 *
 * 三个 API 模块都是 pi-ai 的 `.lazy` 变体：重量级 provider SDK 在真正调用时才加载。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

import { HISTORY_SUMMARY_SYSTEM } from '../agent/prompt'
import type { HistorySummarizer, ModelResolver, ResolvedModel } from '../agent/pi_loop'
import { t } from '../i18n'
import { buildPiProviders, listProviders, readModelsFile } from './pi_config'
import type { ApiType } from './types'

function apiFor(apiType: ApiType): unknown {
  switch (apiType) {
    case 'openai-responses':
      return openAIResponsesApi()
    case 'anthropic-messages':
      return anthropicMessagesApi()
    case 'openai-chat':
    default:
      return openAICompletionsApi()
  }
}

type ModelsCollection = ReturnType<typeof createModels>

export interface PiRuntimeOptions {
  /** 读本机密钥库（`model:<providerId>`）；企业模式下由服务端供流，这里返回 null 即可 */
  getSecret: (ref: string) => string | null
  /** models.json 路径（默认 ~/.hu-agent/agent/models.json）；测试可注入 */
  path?: string
  /** 测试注入（例如 faux provider）；缺省自建 createModels() */
  models?: ModelsCollection
  /** 压缩用的模型（缺省用当前会话模型） */
  fastTarget?: string
}

export interface PiRuntime {
  resolver: ModelResolver
  summarizer: HistorySummarizer
  /** 配置变更后重新注册 provider（设置页保存 models.json 后调用） */
  refresh: () => Promise<void>
}

function parseTarget(target?: string): { providerId: string; modelId: string } {
  if (!target) return { providerId: '', modelId: '' }
  const slash = target.indexOf('/')
  return slash >= 0
    ? { providerId: target.slice(0, slash), modelId: target.slice(slash + 1) }
    : { providerId: '', modelId: target }
}

function extractText(message: { content?: unknown }): string {
  const blocks = message.content
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((block) => {
      const candidate = block as { type?: string; text?: string }
      return candidate.type === 'text' && candidate.text ? candidate.text : ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

export function createPiRuntime(options: PiRuntimeOptions): PiRuntime {
  const models = options.models ?? createModels()
  let loaded = false

  const load = async (): Promise<void> => {
    const file = await readModelsFile(options.path)
    const configs = await listProviders(options.path, (id) => options.getSecret(`model:${id}`) !== null)
    for (const built of buildPiProviders(configs, file, apiFor, options.getSecret)) {
      models.setProvider(built.provider as never)
    }
    loaded = true
  }

  const resolve: ModelResolver['resolve'] = async (target): Promise<ResolvedModel> => {
    if (!loaded) await load()
    const { providerId, modelId } = parseTarget(target)

    if (!providerId) {
      // 未指定目标：取第一个可用 provider 的第一个模型（与设置页"默认模型"缺省行为一致）
      const available = models.getModels()
      const first = available[0] as { provider?: string; id?: string; contextWindow?: number } | undefined
      if (!first?.provider || !first.id) {
        throw new Error(t('未配置模型：请在设置中填写 provider 的 baseUrl、模型与密钥'))
      }
      return {
        providerId: first.provider,
        modelId: first.id,
        contextWindow: first.contextWindow ?? 0,
        model: first,
        streamFn: models.streamSimple.bind(models),
      }
    }

    const model = models.getModel(providerId, modelId) as
      | { id: string; contextWindow?: number }
      | undefined
    if (!model) throw new Error(t('未找到模型：{providerId}/{modelId}（请检查 models.json）', { providerId, modelId }))
    return {
      providerId,
      modelId: model.id,
      contextWindow: model.contextWindow ?? 0,
      model,
      streamFn: models.streamSimple.bind(models),
    }
  }

  const summarizer: HistorySummarizer = {
    summarize: async (history, signal) => {
      const resolved = await resolve(options.fastTarget)
      const message = await models.completeSimple(
        resolved.model as never,
        {
          messages: [
            { role: 'system', content: HISTORY_SUMMARY_SYSTEM, timestamp: Date.now() },
            { role: 'user', content: history, timestamp: Date.now() },
          ],
        } as never,
        { maxTokens: 1_024, signal } as never,
      )
      return extractText(message as { content?: unknown })
    },
  }

  return {
    resolver: { resolve },
    summarizer,
    refresh: async () => {
      loaded = false
      await load()
    },
  }
}
