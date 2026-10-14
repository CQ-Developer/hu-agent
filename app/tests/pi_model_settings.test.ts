/**
 * 模型设置来源桥测试（R3）。
 *
 * 背景：`config.json` 是共用文件（`ui.locale`、全局权限规则、模型设置都在里面）。
 * 保存模型设置时若整体覆盖写，会把用户其它设置一起抹掉——本文件锁定不变式：
 * 桥写 models.json（pi 格式）+ 只往 config.json 写自己的 `defaults`，其它 section 原样保留。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadModelSettings, migrateModelSecretRefs, saveModelSettings } from '../src/main/config/pi_model_settings'
import type { ModelSettings } from '../src/main/model/types'

async function tempConfig(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'huagent-model-settings-'))
  return { dir, configPath: join(dir, 'config.json') }
}

const settings: ModelSettings = {
  providers: [
    {
      id: 'gateway',
      apiType: 'openai-chat',
      baseUrl: 'https://gateway.example.com/v1',
      apiKeyRef: 'model:gateway',
      models: [
        {
          name: 'deepseek-v4.1-flash',
          capabilities: { tools: true, reasoningEffort: true, contextWindow: 200_000, maxOutput: 8_192 },
        },
      ],
    },
  ],
  defaults: { primary: 'gateway/deepseek-v4.1-flash' },
}

describe('模型设置来源桥', () => {
  it('保存后：providers 进 pi 的 models.json，defaults 进 config.json 且其它 section 不变', async () => {
    const { dir, configPath } = await tempConfig()
    // 模拟用户已有设置（语言 + 全局权限规则）
    await writeFile(
      configPath,
      JSON.stringify({ ui: { locale: 'en-US' }, permissions: { rules: [{ tools: ['bash'] }] } }, null, 2),
      'utf8',
    )

    await saveModelSettings({ configPath, agentDir: dir }, settings)

    const models = JSON.parse(await readFile(join(dir, 'models.json'), 'utf8')) as {
      providers: Record<string, { api: string; baseUrl: string }>
    }
    expect(models.providers.gateway).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://gateway.example.com/v1',
    })

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(config.defaults).toEqual({ primary: 'gateway/deepseek-v4.1-flash' })
    expect(config.ui).toEqual({ locale: 'en-US' }) // 不被覆盖
    expect(config.permissions).toEqual({ rules: [{ tools: ['bash'] }] }) // 不被覆盖
  })

  it('读回：providers 从 models.json 投影，defaults 从 config.json 读', async () => {
    const { dir, configPath } = await tempConfig()
    await saveModelSettings({ configPath, agentDir: dir, hasKey: () => true }, settings)

    const loaded = await loadModelSettings({ configPath, agentDir: dir, hasKey: () => true })
    expect(loaded.providers).toHaveLength(1)
    expect(loaded.providers[0]).toMatchObject({
      id: 'gateway',
      apiType: 'openai-chat',
      baseUrl: 'https://gateway.example.com/v1',
      apiKeyRef: 'model:gateway',
    })
    expect(loaded.providers[0].models[0]).toMatchObject({ name: 'deepseek-v4.1-flash' })
    expect(loaded.defaults.primary).toBe('gateway/deepseek-v4.1-flash')
  })

  it('没有 defaults 时按第一个可用 provider 推导（避免界面出现空目标）', async () => {
    const { dir, configPath } = await tempConfig()
    await saveModelSettings({ configPath, agentDir: dir }, { providers: settings.providers, defaults: { primary: '' } })

    const loaded = await loadModelSettings({ configPath, agentDir: dir })
    expect(loaded.defaults.primary).toBe('gateway/deepseek-v4.1-flash')
  })

  it('空配置：没有 provider 时不抛异常，defaults 为空', async () => {
    const { dir, configPath } = await tempConfig()
    const loaded = await loadModelSettings({ configPath, agentDir: dir })
    expect(loaded.providers).toEqual([])
    expect(loaded.defaults.primary).toBe('')
  })
})

describe('模型密钥引用名迁移（provider.<id> → model:<id>）', () => {
  function fakeSecrets(initial: Record<string, string>) {
    const values = new Map(Object.entries(initial))
    return {
      values,
      keys: () => [...values.keys()],
      get: (key: string) => values.get(key) ?? null,
      has: (key: string) => values.has(key),
      set: async (key: string, value: string) => void values.set(key, value),
      delete: async (key: string) => void values.delete(key),
    }
  }

  it('迁移旧引用；已存在的新引用不覆盖；非模型引用不动；幂等', async () => {
    const secrets = fakeSecrets({
      'provider.acme': 'sk-old',
      'provider.other': 'sk-legacy',
      'cloud.refreshToken': 'refresh',
    })
    await secrets.set('model:other', 'sk-new')

    expect(await migrateModelSecretRefs(secrets)).toBe(2)
    expect(secrets.get('model:acme')).toBe('sk-old')
    expect(secrets.get('model:other')).toBe('sk-new') // 不覆盖已有新引用
    expect(secrets.has('provider.acme')).toBe(false)
    expect(secrets.has('provider.other')).toBe(false)
    expect(secrets.get('cloud.refreshToken')).toBe('refresh')

    expect(await migrateModelSecretRefs(secrets)).toBe(0) // 幂等
  })
})
