/**
 * 模型设置的来源桥（R3）：`providers` 存 pi 的 `models.json`，其余部分保留在原配置文件里。
 *
 * 为什么需要桥：pi 的 provider 配置格式（`models.json`）与我们 UI/IPC 使用的 `ProviderConfig[]`
 * 形状不同，但**界面契约不变**——桥负责投影与还原，切换时只把 IPC 的读写指向这里。
 *
 * 关键约定：写配置文件时**只覆盖自己拥有的键**（`defaults`）。
 * `config.json` 是共用文件（`ui.locale`、全局权限规则都在里面），整体覆盖会造成用户设置丢失。
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { listProviders, modelsFilePath, writeProviders } from '../model/pi_config'
import type { ModelSettings, ProviderConfig } from '../model/types'
import { readRawConfig } from './preferences'

export interface ModelSettingsBridgeOptions {
  /** 原配置文件（`~/.hu-agent/config.json`）：defaults 与其它 section 都在这里 */
  configPath: string
  /** agent 目录（models.json 所在），默认 `~/.hu-agent/agent` */
  agentDir?: string
  /** 本机密钥库是否已有该 provider 的密钥（决定 apiKeyRef 是否标记） */
  hasKey?: (providerId: string) => boolean
}

function modelsPath(options: ModelSettingsBridgeOptions): string {
  return options.agentDir ? join(options.agentDir, 'models.json') : modelsFilePath()
}

/** 没有 defaults 时按第一个可用 provider 推导，避免界面出现空目标 */
function deriveDefaults(providers: ProviderConfig[]): ModelSettings['defaults'] {
  const first = providers[0]
  const model = first?.models[0]?.name
  if (!first || !model) return { primary: '' }
  return { primary: `${first.id}/${model}` }
}

export async function loadModelSettings(options: ModelSettingsBridgeOptions): Promise<ModelSettings> {
  const providers = await listProviders(modelsPath(options), options.hasKey ?? (() => false))
  const raw = await readRawConfig(options.configPath)
  const configured = raw.defaults as ModelSettings['defaults'] | undefined
  // 空 primary 视为「未配置」：否则界面会出现指向不存在 provider 的空目标
  const defaults = configured?.primary ? configured : deriveDefaults(providers)
  return { providers, defaults }
}

export async function saveModelSettings(
  options: ModelSettingsBridgeOptions,
  settings: ModelSettings,
): Promise<void> {
  // providers → pi 的 models.json（写回时保留文件内手工配置的 apiKey/headers）
  await writeProviders(settings.providers, { path: modelsPath(options) })

  // defaults → 原配置文件；只覆盖自己拥有的键，保留 ui/permissions 等 section
  const raw = await readRawConfig(options.configPath)
  const merged = { ...raw, defaults: settings.defaults }
  await mkdir(dirname(options.configPath), { recursive: true })
  const temp = `${options.configPath}.tmp`
  await writeFile(temp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  await rename(temp, options.configPath)
}

/**
 * 迁移旧的模型密钥引用名（`provider.<id>` → `model:<id>`），幂等。
 *
 * 历史：早期设置页把模型密钥存在 `provider.<id>` 下，而 pi 运行时按 `model:<providerId>` 读取
 * （ADR-0006 决策 8），导致 UI 保存的密钥对运行时不可见。启动时一次性迁移。
 */
export async function migrateModelSecretRefs(secrets: {
  keys(): string[]
  get(key: string): string | null
  has(key: string): boolean
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}): Promise<number> {
  let migrated = 0
  for (const key of secrets.keys()) {
    if (!key.startsWith('provider.')) continue
    const value = secrets.get(key)
    if (value === null) continue
    const target = `model:${key.slice('provider.'.length)}`
    if (!secrets.has(target)) await secrets.set(target, value)
    await secrets.delete(key)
    migrated += 1
  }
  return migrated
}

/** 与旧 `SettingsStore` 同形的接口（`load/get/save`），便于 IPC 调用点零改动地切换来源 */
export interface ModelSettingsStore {
  load(): Promise<ModelSettings>
  get(): ModelSettings
  save(settings: ModelSettings): Promise<void>
}

/**
 * 桥适配器：把"providers 存 pi 的 models.json、defaults 存 config.json"包装成与 SettingsStore
 * 相同的接口，于是 IPC 层的 `context.settings.load()/save()` 调用完全不用改。
 */
export function createModelSettingsStore(options: ModelSettingsBridgeOptions): ModelSettingsStore {
  let cache: ModelSettings | null = null
  return {
    async load(): Promise<ModelSettings> {
      if (!cache) cache = await loadModelSettings(options)
      return cache
    },
    get(): ModelSettings {
      return cache ?? { providers: [], defaults: { primary: '' } }
    },
    async save(settings: ModelSettings): Promise<void> {
      await saveModelSettings(options, settings)
      cache = settings
    },
  }
}
