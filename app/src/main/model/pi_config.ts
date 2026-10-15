/**
 * provider 配置层：沿用 pi 的 `models.json` 格式（ADR-0006 决策 8）。
 *
 * 为什么沿用 pi 的格式：同一份配置在 pi CLI 与我们客户端之间可直接互换，用户不必维护两套。
 * 为什么用薄适配而不是 `pi-coding-agent` 的 `ModelRegistry`：该包解包 31 MB 且把
 * `pi-tui`/`mermaid`/`highlight.js` 等 CLI/界面依赖装进桌面应用，收益仅是"读一个 JSON"；
 * 我们只需要它的**格式与类型**（`ProviderModelConfig` 仅作类型引入，运行时不加载）。
 * 若将来体积不是问题，把本文件的 `readModelsFile` 换成 `ModelRegistry` 即可，格式不变。
 *
 * 密钥策略（ADR-0002 + 决策 9）：
 * 1. `models.json` 里显式写了 `apiKey` → 用它（便于复用 pi CLI 的配置或手工配置）；
 * 2. 否则按 provider id 从本机密钥库取（safeStorage，`model:<providerId>`），密钥不落 models.json；
 * 3. 企业模式两者都不走：密钥在服务端，由服务端 `streamProxy` 供流。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createProvider } from '@earendil-works/pi-ai/models'

import type { ApiType, ModelEntry, ProviderConfig } from './types'

/** 本应用自己的 agent 目录（不碰 pi CLI 的 ~/.pi/agent，除非用户显式指向它） */
const AGENT_DIR_ENV = 'HUAGENT_AGENT_DIR'

/** 我们的 API 类型标签 ↔ pi 的 api id */
const TO_PI_API: Record<ApiType, string> = {
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
}
const FROM_PI_API: Record<string, ApiType> = {
  'openai-completions': 'openai-chat',
  'openai-chat': 'openai-chat',
  'openai-responses': 'openai-responses',
  'azure-openai-responses': 'openai-responses',
  'anthropic-messages': 'anthropic-messages',
}

/** models.json 中一个 provider 的定义（pi 格式，字段有意宽松以兼容手工编辑） */
export interface PiProviderConfig {
  api?: string
  baseUrl?: string
  apiKey?: string
  headers?: Record<string, string>
  models?: Array<Record<string, unknown> & { id?: string; name?: string }>
}

export interface PiModelsFile {
  providers: Record<string, PiProviderConfig>
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[AGENT_DIR_ENV]?.trim()
  return configured && configured.length > 0 ? configured : join(homedir(), '.hu-agent', 'agent')
}

export function modelsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), 'models.json')
}

function emptyFile(): PiModelsFile {
  return { providers: {} }
}

/** 读取并做最小校验；文件不存在时返回空配置（调用方按"未配置 provider"处理） */
export async function readModelsFile(path = modelsFilePath()): Promise<PiModelsFile> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return emptyFile()
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) return emptyFile()
  const providers = (parsed as { providers?: unknown }).providers
  if (typeof providers !== 'object' || providers === null) return emptyFile()
  return { providers: providers as Record<string, PiProviderConfig> }
}

/** 写回 pi 格式。刻意不写 `apiKey`（密钥在密钥库；显式写入的值会被保留） */
export async function writeProviders(
  configs: ProviderConfig[],
  options: { path?: string; keyFor?: (providerId: string) => string | null } = {},
): Promise<void> {
  const path = options.path ?? modelsFilePath()
  const existing = await readModelsFile(path)
  const providers: Record<string, PiProviderConfig> = {}

  for (const config of configs) {
    const previous = existing.providers[config.id] ?? {}
    const inlineKey = options.keyFor?.(config.id) ?? previous.apiKey
    providers[config.id] = {
      api: TO_PI_API[config.apiType],
      baseUrl: config.baseUrl,
      ...(inlineKey ? { apiKey: inlineKey } : {}),
      ...(previous.headers ? { headers: previous.headers } : {}),
      models: config.models.map((model) => ({
        id: model.name,
        name: model.name,
        reasoning: model.capabilities.reasoningEffort === true,
        contextWindow: model.capabilities.contextWindow,
        ...(model.capabilities.maxOutput ? { maxTokens: model.capabilities.maxOutput } : {}),
      })),
    }
  }

  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ providers }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 })
}

/** 投影成应用内/UI 使用的形状（含密钥引用，不含密钥值） */
export async function listProviders(
  path = modelsFilePath(),
  hasKey: (providerId: string) => boolean = () => false,
): Promise<ProviderConfig[]> {
  const file = await readModelsFile(path)
  return Object.entries(file.providers).map(([id, provider]) => ({
    id,
    apiType: FROM_PI_API[provider.api ?? 'openai-completions'] ?? 'openai-chat',
    baseUrl: provider.baseUrl ?? '',
    apiKeyRef: provider.apiKey || hasKey(id) ? `model:${id}` : null,
    models: (provider.models ?? [])
      .filter((model): model is Record<string, unknown> & { id: string } => typeof model.id === 'string')
      .map(
        (model): ModelEntry => ({
          name: model.id,
          capabilities: {
            tools: true,
            vision: Array.isArray(model.input) && model.input.includes('image'),
            reasoningEffort: model.reasoning === true,
            contextWindow: typeof model.contextWindow === 'number' ? model.contextWindow : 128_000,
            maxOutput: typeof model.maxTokens === 'number' ? model.maxTokens : undefined,
          },
        }),
      ),
  }))
}

export interface BuiltProvider {
  id: string
  config: ProviderConfig
  /** pi 的 Provider 实例，交给 createModels().setProvider() */
  provider: unknown
}

/**
 * 构造 pi 的 Provider：models 必须是**完整 Model 对象**（含 api/provider/baseUrl），
 * auth 必须是 `{ apiKey: {...} }` 形状——这两点是 P1 踩坑记录，改动前请先看
 * `tests/integration/pi-real.test.ts` 的注释。
 */
export function buildPiProviders(
  configs: ProviderConfig[],
  file: PiModelsFile,
  apiFor: (apiType: ApiType) => unknown,
  getSecret: (ref: string) => string | null,
): BuiltProvider[] {
  return configs.map((config) => {
    const raw = file.providers[config.id] ?? {}
    const key = raw.apiKey ?? getSecret(`model:${config.id}`) ?? ''
    const provider = createProvider({
      id: config.id,
      name: config.id,
      baseUrl: config.baseUrl,
      auth: {
        apiKey: {
          name: `${config.id} API Key`,
          login: async () => ({ type: 'api_key' as const, key }),
          resolve: async () => ({ auth: { apiKey: key }, source: 'local secret store' as const }),
        },
      },
      models: config.models.map((model) => ({
        id: model.name,
        name: model.name,
        api: TO_PI_API[config.apiType],
        provider: config.id,
        baseUrl: config.baseUrl,
        reasoning: model.capabilities.reasoningEffort === true,
        input: ['text'],
        contextWindow: model.capabilities.contextWindow,
        maxTokens: model.capabilities.maxOutput ?? 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      })),
      api: apiFor(config.apiType),
    } as Parameters<typeof createProvider>[0])
    return { id: config.id, config, provider }
  })
}
