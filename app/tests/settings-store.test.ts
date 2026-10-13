/** 配置迁移：旧版 type:'openai-compatible' 自动升级为 apiType。 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SettingsStore, defaultModelSettings } from '../src/main/config/settings-store'

describe('SettingsStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-settings-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('旧配置（type: openai-compatible）迁移为 apiType: openai-chat', async () => {
    const file = join(dir, 'config.json')
    await writeFile(
      file,
      JSON.stringify({
        providers: [
          {
            id: 'legacy',
            type: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            apiKeyRef: 'legacy',
            models: [{ name: 'm1', capabilities: { tools: true, contextWindow: 1000 } }],
          },
        ],
        defaults: { primary: 'legacy/m1' },
      }),
      'utf8',
    )

    const settings = await new SettingsStore(file).load()
    expect(settings.providers[0]).toMatchObject({ id: 'legacy', apiType: 'openai-chat' })
  })

  it('未知 apiType 回退为 openai-chat', async () => {
    const file = join(dir, 'config.json')
    await writeFile(
      file,
      JSON.stringify({
        providers: [{ id: 'x', apiType: 'unknown-type', baseUrl: 'https://x', models: [] }],
        defaults: { primary: '' },
      }),
      'utf8',
    )
    const settings = await new SettingsStore(file).load()
    expect(settings.providers[0]?.apiType).toBe('openai-chat')
  })

  it('默认配置为 ollama + openai-chat', () => {
    const settings = defaultModelSettings()
    expect(settings.providers[0]?.apiType).toBe('openai-chat')
    expect(settings.defaults.primary).toContain('ollama/')
  })
})
