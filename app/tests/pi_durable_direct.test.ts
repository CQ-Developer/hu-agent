/**
 * pi-durable 直接集成 spike（R1 前置验证之二）：验证"不用门面"所依赖的原生能力。
 *
 * 覆盖：
 * 1. `root.configure()` 按会话持久化 agent 配置（模型 / thinkingLevel / cwd / instructions），重开后仍在；
 * 2. `root.viewState()` 给出 UI 需要的结构视图（entries 与 pi.live/pi.usage/pi.agent 文档）且可订阅；
 * 3. `harness.usage()` 汇总整会话用量（模型 + 工具分账）；
 * 4. `harness.snapshot(doc, id)` 读回自持文档（defineDoc 形状）。
 *
 * 用 faux provider，零网络；验证的是 durable 的状态与投影契约，不是模型行为。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry, defineDoc } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const MODEL = 'faux-1'

/** 应用自持文档示例（将来放我们自己的每会话状态，如引导卡答案） */
const AppNote = defineDoc<{ text: string }>({
  kind: 'huagent.note',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ text: '' }),
})

function modelsWithFaux() {
  const faux = fauxProvider({ models: [{ id: MODEL, name: 'Faux 1' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  return { models, faux }
}

describe('pi-durable 直接集成 spike', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-direct-'))
    file = join(dir, 'session.sqlite')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined)
  })

  it('configure 持久化会话配置；viewState 给出 entries 与文档；usage 可汇总', async () => {
    const { models, faux } = modelsWithFaux()
    faux.setResponses([fauxAssistantMessage([fauxText('收到')])])

    const storage = await openNodeSqliteStorage(file)
    const harness = await Harness.open(
      storage,
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    )
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: MODEL } },
    })

    try {
    // 1) 会话配置（等价于我们的"会话选项"：模型 / 思考强度 / 工作目录 / 附加指令）
    await root.configure(
      {
        model: { provider: 'faux', modelId: MODEL },
        thinkingLevel: 'low',
        cwd: dir,
        instructions: '只读，不要修改文件。',
      },
      BACKGROUND_CONTEXT,
    )
    const agent = await root.agent(BACKGROUND_CONTEXT)
    expect(agent.model).toMatchObject({ provider: 'faux', modelId: MODEL })
    expect(agent.cwd).toBe(dir)
    expect(agent.instructions).toContain('只读')

    // 2) UI 结构视图：entries（transcript）+ 运行状态与用量文档
    const view = await root.viewState(BACKGROUND_CONTEXT)
    const seen: string[] = []
    const unsubscribe = view.subscribe((value) => {
      seen.push(Object.keys(value.docs ?? {}).join(','))
    })

    await root.submit({ type: 'input', content: '你好', requestId: 'direct-1' }, BACKGROUND_CONTEXT)

    const state = await root.viewState(BACKGROUND_CONTEXT)
    const shape = state as unknown as {
      constructor?: { name?: string }
      get?: () => unknown
      value?: unknown
      subscribe?: unknown
      dispose?: unknown
    }
    console.log(
      '[direct] viewState 形状 =',
      shape.constructor?.name,
      '| 键 =',
      Object.keys(shape).join(','),
      '| 有 get =',
      typeof shape.get,
      '| 有 value =',
      typeof shape.value,
      '| 有 subscribe =',
      typeof shape.subscribe,
    )
    const snapshot = typeof shape.get === 'function' ? shape.get() : (shape.value ?? shape)
    console.log('[direct] 快照键 =', Object.keys(snapshot as object).join(','))
    const value = snapshot as { conversation?: unknown; entries?: unknown; docs?: Record<string, unknown> }
    expect(value.entries).toBeDefined() // transcript（形状由 pi-durable 决定，我们只投影）
    expect(value.conversation).toBeDefined()
    expect(value.docs?.['pi.usage']).toBeDefined() // 用量按会话落文档
    expect(value.docs?.['pi.agent']).toBeDefined() // 会话配置文档
    unsubscribe()

    // 3) 用量汇总（模型/工具分账）；faux 的用量为 0，此处只验证契约可读
    const usage = await harness.usage(BACKGROUND_CONTEXT)
    expect(usage).toBeDefined()
    console.log(
      '[direct] usage.models =',
      JSON.stringify(usage.models ?? {}).slice(0, 120),
      '| usage.tools =',
      JSON.stringify(usage.tools ?? {}).slice(0, 120),
    )

    // 4) 自持文档：写入并读回（将来放每会话的应用状态）
    await root.commit(async (tx) => {
      const doc = await tx.doc(AppNote, root.id)
      doc.text = '引导卡答案'
    }, BACKGROUND_CONTEXT)
    const note = await harness.snapshot(AppNote, root.id, BACKGROUND_CONTEXT)
    expect(note?.text).toBe('引导卡答案')
    } finally {
      await storage.close().catch(() => undefined)
    }
  }, 60_000)

  it('重开后 configure 的配置与自持文档仍在（直接集成不需要门面）', async () => {
    const { models } = modelsWithFaux()

    const first = await openNodeSqliteStorage(file)
    const harness1 = await Harness.open(first, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
    const root1 = await harness1.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: MODEL } },
    })
    await root1.configure({ cwd: dir, thinkingLevel: 'high' }, BACKGROUND_CONTEXT)
    await root1.commit(async (tx) => {
      const doc = await tx.doc(AppNote, root1.id)
      doc.text = '持久化检验'
    }, BACKGROUND_CONTEXT)
    await first.close()

    const second = await openNodeSqliteStorage(file)
    const harness2 = await Harness.open(second, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
    const root2 = await harness2.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: MODEL } },
    })

    const agent = await root2.agent(BACKGROUND_CONTEXT)
    expect(agent.cwd).toBe(dir)
    expect(agent.thinkingLevel).toBe('high')

    const note = await harness2.snapshot(AppNote, root2.id, BACKGROUND_CONTEXT)
    expect(note?.text).toBe('持久化检验')

    await second.close()
  }, 60_000)
})
