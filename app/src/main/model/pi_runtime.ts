/**
 * pi 运行时装配：把配置层（`pi-config`）读到的 `models.json` 注册进 pi-ai 的 `models` 集合。
 *
 * 这是**长生命周期**对象：会话服务（`DurableSessions`）与 harness 共用同一份 `models`，
 * 所以设置页保存/删除 provider 后必须调用 `refresh()` 重新注册（见 `ipc.ts`）。
 *
 * 三个 API 模块都是 pi-ai 的 `.lazy` 变体：重量级 provider SDK 在真正调用时才加载。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'

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
}

export interface PiRuntime {
  /** 暴露 pi 的 models 集合：`DurableSessions` 必须与运行时共用同一份已注册 provider 的集合 */
  models: ModelsCollection
  /** 重新注册 provider：已删除的 provider 会被注销（设置页保存/删除后调用） */
  refresh: () => Promise<void>
}

export function createPiRuntime(options: PiRuntimeOptions): PiRuntime {
  const models = options.models ?? createModels()
  let registered = new Set<string>()

  const refresh = async (): Promise<void> => {
    const file = await readModelsFile(options.path)
    const configs = await listProviders(options.path, (id) => options.getSecret(`model:${id}`) !== null)
    const next = new Set<string>()
    for (const built of buildPiProviders(configs, file, apiFor, options.getSecret)) {
      models.setProvider(built.provider as never)
      next.add(built.id)
    }
    for (const id of registered) {
      if (!next.has(id)) models.deleteProvider(id)
    }
    registered = next
  }

  return { models, refresh }
}
