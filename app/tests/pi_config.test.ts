/**
 * provider 配置层测试（pi 的 models.json 格式，ADR-0006 决策 8）。
 *
 * 覆盖三件容易出错的事：
 * 1. 与 pi 的字段映射（api id、apiKey 有无、模型能力）；
 * 2. 密钥优先级：文件内 apiKey > 本机密钥库；写回时**不把密钥库的值写进文件**；
 * 3. 缺文件/坏文件不抛异常（应用首次启动时必然没有这个文件）。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { agentDir, listProviders, modelsFilePath, readModelsFile, writeProviders } from '../src/main/model/pi_config'
import type { ProviderConfig } from '../src/main/model/types'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'huagent-pi-config-'))
}

const sample: ProviderConfig[] = [
  {
    id: 'gateway',
    apiType: 'openai-chat',
    baseUrl: 'https://gateway.example.com/v1',
    apiKeyRef: 'model:gateway',
    models: [
      {
        name: 'deepseek-v4.1-flash',
        capabilities: { tools: true, vision: true, reasoningEffort: true, contextWindow: 200_000, maxOutput: 8_192 },
      },
    ],
  },
  {
    id: 'anthropic-direct',
    apiType: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKeyRef: null,
    models: [{ name: 'claude-sonnet-4-6', capabilities: { tools: true, contextWindow: 200_000 } }],
  },
]

describe('pi models.json 配置层', () => {
  it('默认目录是 ~/.hu-agent/agent，可用 HUAGENT_AGENT_DIR 覆盖', () => {
    expect(agentDir({})).toMatch(/\.hu-agent[\\/]agent$/)
    expect(modelsFilePath({ HUAGENT_AGENT_DIR: 'C:/custom/agent' })).toMatch(/custom[\\/]agent[\\/]models\.json$/)
  })

  it('缺文件时返回空配置而不抛异常', async () => {
    const file = await readModelsFile(join(await tempDir(), 'models.json'))
    expect(file).toEqual({ providers: {} })
  })

  it('坏 JSON 会抛出（配置损坏必须让用户看到，而不是静默用空配置）', async () => {
    const dir = await tempDir()
    const path = join(dir, 'models.json')
    await writeFile(path, '{ this is not json', 'utf-8')
    await expect(readModelsFile(path)).rejects.toThrow()
  })

  it('写回 pi 格式且不写入密钥库中的密钥', async () => {
    const path = join(await tempDir(), 'models.json')
    await writeProviders(sample, { path, keyFor: () => null })

    const written = JSON.parse(await readFile(path, 'utf-8')) as { providers: Record<string, unknown> }
    expect(written.providers.gateway).toMatchObject({
      api: 'openai-completions',
      baseUrl: 'https://gateway.example.com/v1',
    })
    expect(written.providers.gateway).not.toHaveProperty('apiKey')
    expect(written.providers['anthropic-direct']).toMatchObject({ api: 'anthropic-messages' })

    const models = (written.providers.gateway as { models: Array<Record<string, unknown>> }).models
    expect(models[0]).toMatchObject({
      id: 'deepseek-v4.1-flash',
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 8_192,
    })
  })

  it('读回后可投影成应用形状，并标记密钥来源', async () => {
    const path = join(await tempDir(), 'models.json')
    await writeProviders(sample, { path, keyFor: () => null })
    // 模拟"密钥在本机密钥库"
    const providers = await listProviders(path, (id) => id === 'gateway')
    const gateway = providers.find((provider) => provider.id === 'gateway')
    expect(gateway).toMatchObject({ apiType: 'openai-chat', baseUrl: 'https://gateway.example.com/v1' })
    expect(gateway?.apiKeyRef).toBe('model:gateway')
    expect(gateway?.models[0]).toMatchObject({ name: 'deepseek-v4.1-flash' })
    expect(gateway?.models[0].capabilities).toMatchObject({ reasoningEffort: true, contextWindow: 200_000 })

    const anthropic = providers.find((provider) => provider.id === 'anthropic-direct')
    expect(anthropic?.apiKeyRef).toBeNull()
    expect(anthropic?.models[0].capabilities.contextWindow).toBe(200_000)
  })

  it('文件里手工写的 apiKey 优先，且会被保留（兼容 pi CLI 配置）', async () => {
    const dir = await tempDir()
    const path = join(dir, 'models.json')
    await writeFile(
      path,
      JSON.stringify({
        providers: {
          gateway: {
            api: 'openai-completions',
            baseUrl: 'https://gateway.example.com/v1',
            apiKey: 'sk-from-file',
            headers: { 'x-tenant': 'acme' },
            models: [{ id: 'glm-5.3', name: 'GLM 5.3', reasoning: false }],
          },
        },
      }),
      'utf-8',
    )

    const providers = await listProviders(path, () => false)
    expect(providers[0].apiKeyRef).toBe('model:gateway')

    await writeProviders(providers, { path, keyFor: () => null })
    const written = JSON.parse(await readFile(path, 'utf-8')) as { providers: Record<string, { apiKey?: string; headers?: unknown }> }
    expect(written.providers.gateway.apiKey).toBe('sk-from-file') // 手工配置不被抹掉
    expect(written.providers.gateway.headers).toEqual({ 'x-tenant': 'acme' })
  })
})
