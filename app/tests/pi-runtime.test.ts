/**
 * pi 运行时装配测试（P1.2-d）。
 *
 * 用 pi 自带的 faux provider 注入到 `models` 集合里，验证：
 * 1. `resolve()` 能按 "provider/model" 解析出模型、上下文窗口与流式函数；
 * 2. 未指定目标时走"第一个可用模型"，没有任何 provider 时给出可操作的中文提示；
 * 3. `summarize()` 走一次非流式调用并抽出文本（压缩链路依赖它）。
 *
 * 不联网：faux provider 是确定性实现。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createPiRuntime } from '../src/main/model/pi-runtime'

async function runtime() {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux 1', contextWindow: 64_000 }] })
  const models = createModels()
  models.setProvider(faux.provider)
  const path = join(await mkdtemp(join(tmpdir(), 'huagent-runtime-')), 'models.json')
  const instance = createPiRuntime({ getSecret: () => null, models, path })
  return { faux, instance }
}

describe('pi 运行时装配', () => {
  it('按 provider/model 解析模型并返回流式函数', async () => {
    const { instance } = await runtime()
    const resolved = await instance.resolver.resolve('faux/faux-1')

    expect(resolved.providerId).toBe('faux')
    expect(resolved.modelId).toBe('faux-1')
    expect(resolved.contextWindow).toBe(64_000)
    expect(typeof resolved.streamFn).toBe('function')
  })

  it('未指定目标时取第一个可用模型；没有 provider 时报可操作错误', async () => {
    const { instance } = await runtime()
    const fallback = await instance.resolver.resolve(undefined)
    expect(fallback.providerId).toBe('faux')

    const empty = createPiRuntime({ getSecret: () => null, models: createModels() })
    await expect(empty.resolver.resolve(undefined)).rejects.toThrow(/未配置模型/)
  })

  it('未知模型给出可读错误（指向 models.json）', async () => {
    const { instance } = await runtime()
    await expect(instance.resolver.resolve('faux/不存在')).rejects.toThrow(/未找到模型/)
  })

  it('summarize() 走非流式调用并抽出文本（压缩链路）', async () => {
    const { faux, instance } = await runtime()
    faux.setResponses([fauxAssistantMessage('摘要：用户询问了部署方式。')])

    const summary = await instance.summarizer.summarize('很长的历史记录', new AbortController().signal)
    expect(summary).toBe('摘要：用户询问了部署方式。')
    expect(faux.state.callCount).toBe(1)
  })
})
