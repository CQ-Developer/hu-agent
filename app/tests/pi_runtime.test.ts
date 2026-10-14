/**
 * pi 运行时装配测试（R1 切换后）：`createPiRuntime` 是长生命周期对象，只负责把
 * `models.json` 注册进 pi-ai 的 `models` 集合（会话服务与 harness 共用这份集合）。
 *
 * 覆盖：refresh 注册 provider 与模型；refresh 注销已删除的 provider；无文件时不抛错。
 * 不联网：只验证注册表，不发请求。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createPiRuntime } from '../src/main/model/pi_runtime'

function modelsFile(providers: Record<string, unknown>): string {
  return JSON.stringify({ providers })
}

const alpha = {
  api: 'openai-completions',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'test-key-not-real',
  models: [{ id: 'alpha-1', name: 'alpha-1', contextWindow: 4096 }],
}

const beta = {
  api: 'openai-completions',
  baseUrl: 'https://example.invalid/v1',
  models: [{ id: 'beta-1', name: 'beta-1', contextWindow: 8192 }],
}

async function pathFor(content?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'huagent-runtime-'))
  const path = join(dir, 'models.json')
  if (content !== undefined) await writeFile(path, content, 'utf8')
  return path
}

describe('pi 运行时装配', () => {
  it('refresh 注册 models.json 中的 provider 与模型', async () => {
    const path = await pathFor(modelsFile({ alpha }))
    const runtime = createPiRuntime({ getSecret: () => null, path })

    await runtime.refresh()

    expect(runtime.models.getProvider('alpha')).toBeDefined()
    expect(runtime.models.getModel('alpha', 'alpha-1')).toBeDefined()
  })

  it('refresh 注销已删除的 provider（设置页删除后立即生效）', async () => {
    const path = await pathFor(modelsFile({ alpha, beta }))
    const runtime = createPiRuntime({ getSecret: () => null, path })
    await runtime.refresh()
    expect(runtime.models.getModel('beta', 'beta-1')).toBeDefined()

    await writeFile(path, modelsFile({ beta }), 'utf8')
    await runtime.refresh()

    expect(runtime.models.getProvider('alpha')).toBeUndefined()
    expect(runtime.models.getModel('beta', 'beta-1')).toBeDefined()
  })

  it('models.json 不存在时不抛错，集合为空（回合再给可操作提示）', async () => {
    const runtime = createPiRuntime({ getSecret: () => null, path: await pathFor() })
    await runtime.refresh()
    expect(runtime.models.getModels()).toEqual([])
  })
})
