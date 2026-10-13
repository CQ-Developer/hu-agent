/** 模型配置读写（~/.hu-agent/config.json，design 5.9）。 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ModelSettings } from '../model/types'

export function defaultModelSettings(): ModelSettings {
  return {
    providers: [
      {
        id: 'ollama',
        type: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKeyRef: null,
        models: [
          {
            name: 'qwen2.5:7b',
            roles: ['primary', 'fast'],
            capabilities: { tools: true, contextWindow: 32768, maxOutput: 4096 },
          },
        ],
      },
    ],
    defaults: { primary: 'ollama/qwen2.5:7b', fast: 'ollama/qwen2.5:7b' },
  }
}

export class SettingsStore {
  private cache: ModelSettings | null = null

  constructor(private readonly file: string) {}

  async load(): Promise<ModelSettings> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as ModelSettings
      if (Array.isArray(parsed.providers) && parsed.defaults) {
        this.cache = parsed
        return parsed
      }
    } catch {
      // 首次运行或文件损坏：使用默认值
    }
    this.cache = defaultModelSettings()
    return this.cache
  }

  get(): ModelSettings {
    return this.cache ?? defaultModelSettings()
  }

  async save(settings: ModelSettings): Promise<void> {
    this.cache = settings
    await mkdir(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    await writeFile(temp, JSON.stringify(settings, null, 2), 'utf8')
    await rename(temp, this.file)
  }
}
