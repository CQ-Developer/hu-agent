/**
 * pi-durable spike（R1 前置验证）：只读实验，不改产品代码。
 *
 * 要回答三个问题（决定 R1 能不能把会话/消息交给 pi-durable）：
 * 1. **写入先于展示 / 重开可续**：进程结束再重开同一份存储，会话还在；
 * 2. **requestId 幂等**：跨重启重复提交同一 requestId 返回同一个 submission（不重复生成）——
 *    这正是我们同步/重试语义需要的保证；
 * 3. **resume() 可用**：上次进程留下的未完成运行能继续，且不会阻塞。
 *
 * 用 faux provider（确定性、零网络）跑，验证的是存储与提交语义，不是模型行为。
 */

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const MODEL = 'faux-1'

function modelsWithFaux() {
  const faux = fauxProvider({ models: [{ id: MODEL, name: 'Faux 1' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  return { models, faux }
}

describe('pi-durable spike（SQLite 存储 + 重开续跑 + 幂等提交）', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-'))
    file = join(dir, 'session.sqlite')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('跨重开：存储保留会话，且同一 requestId 返回同一 submission', async () => {
    const { models } = modelsWithFaux()
    const first = await openNodeSqliteStorage(file)
    const harness1 = await Harness.open(first, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
    const root1 = await harness1.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: MODEL } },
    })

    const submission = await root1.submit(
      { type: 'input', content: '只回复两个字：收到', requestId: 'spike-1' },
      BACKGROUND_CONTEXT,
    )
    expect(submission.id).toBeTruthy()
    await first.close()

    // 存储文件确实落盘（SQLite 是单文件）
    const info = await stat(file)
    expect(info.size).toBeGreaterThan(0)

    // 重开同一份存储：拿到同一个 root（同一会话），并验证 requestId 幂等
    const second = await openNodeSqliteStorage(file)
    const harness2 = await Harness.open(second, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
    harness2.resume() // 继续上次中断的运行；不应抛错
    const root2 = await harness2.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: MODEL } },
    })

    const again = await root2.submit(
      { type: 'input', content: '只回复两个字：收到', requestId: 'spike-1' },
      BACKGROUND_CONTEXT,
    )
    expect(again.id).toBe(submission.id) // 跨重启幂等：不会重复提交

    // 新 requestId 才产生新 submission
    const fresh = await root2.submit(
      { type: 'input', content: '另一条消息', requestId: 'spike-2' },
      BACKGROUND_CONTEXT,
    )
    expect(fresh.id).not.toBe(submission.id)

    await second.close()
  }, 60_000)

  it('重开后可重新取回历史 submission（harness.submission）', async () => {
    const { models, faux } = modelsWithFaux()
    faux.setResponses([fauxAssistantMessage([fauxText('收到')])])

    const first = await openNodeSqliteStorage(file)
    const harness1 = await Harness.open(first, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
    const root1 = await harness1.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: 'faux', modelId: MODEL } },
    })
    const submission = await root1.submit(
      { type: 'input', content: '你好', requestId: 'persist-1' },
      BACKGROUND_CONTEXT,
    )
    await first.close()

    const second = await openNodeSqliteStorage(file)
    const harness2 = await Harness.open(second, { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
    const restored = await harness2.submission(submission.id)
    expect(restored?.id).toBe(submission.id)
    await second.close()
  }, 60_000)
})
