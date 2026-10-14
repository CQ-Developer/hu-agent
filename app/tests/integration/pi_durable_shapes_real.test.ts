/**
 * pi-durable 读取面形状勘察（R1 收尾前置）：把界面/用量需要的**真实数据结构**固定下来。
 *
 * 为什么要做：R1 最后一步要把回合改成 submit + 订阅 viewState，并把 IPC 的会话列表/消息/工具卡/用量
 * 全部改为从 durable 读取。这些"读"的形状（entries 的条目形态、docs["pi.live"] 里的工具调用与输出、
 * docs["pi.usage"] 的分账键）必须先成为事实，否则只能盲写、反复返工。
 *
 * 门禁：`PI_E2E=1` + `PI_AGENT_DIR`；只用 `deepseek-v4.1-flash`。运行一次即可，输出即为结论。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, ToolTask, createRegistry, defineExtension, defineTool, hook, section } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Type } from 'typebox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ALLOWED_MODEL = 'deepseek-v4.1-flash'
const PROVIDER = process.env.PI_GATEWAY_PROVIDER ?? 'token-hub'
const agentDir = process.env.PI_AGENT_DIR ?? ''
const enabled = process.env.PI_E2E === '1' && agentDir !== ''

function summarize(value: unknown, limit = 400): string {
  try {
    const text = JSON.stringify(value)
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  } catch {
    return String(value)
  }
}

describe.skipIf(!enabled)('pi-durable 读取面形状（真实模型）', () => {
  let dir: string
  let file: string
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-shapes-'))
    file = join(dir, 'session.sqlite')
  })

  afterEach(async () => {
    await storage?.close(BACKGROUND_CONTEXT).catch(() => undefined)
    storage = null
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined)
  })

  it('勘察 entries / pi.live / pi.usage / pi.inbox 的形状', async () => {
    const executed: string[] = []

    const echo = defineTool({
      name: 'echo',
      description: '回显给定文本',
      parameters: Type.Object({ text: Type.String({ description: '要回显的文本' }) }),
      execute: async (_id: string, params: { text?: string }) => {
        executed.push(String(params?.text ?? ''))
        return { content: [{ type: 'text', text: `echo:${params?.text}` }] }
      },
    })
    const Tools = defineExtension({ name: 'huagent.tools', tools: [echo] })
    const Guard = defineExtension({
      name: 'huagent.guard',
      sections: [section('workspace', () => '工作空间：/ws', { tag: false })],
      hooks: [hook(ToolTask, { beforeTool: async () => undefined })],
    })

    const registry = createRegistry()
    registry.install(Tools)
    registry.install(Guard)

    const { listProviders, readModelsFile, buildPiProviders } = await import('../../src/main/model/pi_config')
    const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
    const models = createModels()
    const configPath = join(agentDir, 'models.json')
    const configFile = await readModelsFile(configPath)
    const providers = await listProviders(configPath, () => false)
    for (const built of buildPiProviders(providers, configFile, () => openAICompletionsApi(), () => null)) {
      models.setProvider(built.provider as never)
    }

    storage = await openNodeSqliteStorage(file)
    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT)
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER, modelId: ALLOWED_MODEL } },
    })
    await root.configure({ extensions: [Tools, Guard], tools: [echo], modelTools: [echo] }, BACKGROUND_CONTEXT)

    const submission = await root.submit(
      {
        type: 'input',
        content: '请调用 echo 工具，参数 text 为 "hi"。调用后回复"完成"。',
        requestId: 'shapes-1',
      },
      BACKGROUND_CONTEXT,
    )
    await submission.wait(BACKGROUND_CONTEXT)

    const state = (await root.viewState(BACKGROUND_CONTEXT)) as unknown as {
      value?: { conversation?: unknown; entries?: unknown; docs?: Record<string, unknown> }
    }
    const value = state.value ?? (state as unknown as { entries?: unknown; docs?: Record<string, unknown> })
    const docs = value.docs ?? {}

    // —— 勘察输出（运行一次即得结论，随后写入 ADR 作为编码依据）——
    console.log('[shapes] executed =', executed.join(','))
    console.log('[shapes] docs keys =', Object.keys(docs).join(','))
    console.log('[shapes] entries 类型 =', Array.isArray(value.entries) ? `array(${value.entries.length})` : typeof value.entries)
    const entries = Array.isArray(value.entries) ? (value.entries as Array<Record<string, unknown>>) : []
    console.log('[shapes] entry 键样本 =', entries.slice(0, 6).map((entry) => Object.keys(entry).join('|')).join(' ;; '))
    console.log('[shapes] entry 内容样本 =', summarize(entries.slice(0, 3), 500))
    console.log('[shapes] pi.live =', summarize(docs['pi.live'], 500))
    console.log('[shapes] pi.usage =', summarize(docs['pi.usage'], 400))
    console.log('[shapes] pi.inbox =', summarize(docs['pi.inbox'], 300))
    console.log('[shapes] pi.agent =', summarize(docs['pi.agent'], 300))
    const usage = await harness.usage(BACKGROUND_CONTEXT)
    console.log('[shapes] harness.usage =', summarize(usage, 400))

    // 派发管线已验证：钩子放行时工具确实执行（模型可能把参数传空，故只断言执行次数）
    expect(executed).toHaveLength(1)
    expect(value.entries).toBeDefined()
    expect(value.entries).toBeDefined()
  }, 240_000)
})
