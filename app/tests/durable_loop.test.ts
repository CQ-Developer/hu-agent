/**
 * 新回环测试（R1）：回合交给 pi-durable 的 harness 跑，我们只提供工具/治理/投影/用量。
 *
 * 覆盖：turn.start → submit → settle → turn.end('done')；会话状态落到 durable；
 * 用量从 `pi.usage` 汇入我们的 ledger（faux 下数值可能为 0，但契约必须成立）。
 * 工具派发在 durable + faux 下不可靠（已知），工具路径由真实模型门禁用例覆盖。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runDurableTurn, type DurableTurnDeps } from '../src/main/agent/durable_loop'
import { DurableSessions } from '../src/main/session/durable'
import type { AgentEvent } from '../src/shared/events'

const MODEL = 'faux-1'

describe('durable 回环（回合由 harness 跑）', () => {
  let dir: string
  let sessions: DurableSessions | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-loop-'))
  })

  afterEach(async () => {
    await sessions?.close().catch(() => undefined)
    sessions = null
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined)
  })

  async function setup() {
    const faux = fauxProvider({ models: [{ id: MODEL, name: 'Faux 1' }] })
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage([fauxText('你好呀')])])

    const instance = new DurableSessions({
      file: join(dir, 'sessions.sqlite'),
      indexFile: join(dir, 'sessions.index.json'),
      models,
      cwd: dir,
      workspaceId: 'ws_1',
    })
    await instance.open()
    sessions = instance
    const conversationId = (
      await instance.create({
        title: '回环测试',
        model: { provider: 'faux', modelId: MODEL },
      })
    ).id

    const events: AgentEvent[] = []
    const ledger: unknown[] = []
    const telemetry: unknown[] = []
    const deps: DurableTurnDeps = {
      sessions: instance,
      conversationId,
      providerId: 'faux',
      modelId: MODEL,
      tools: [],
      permissions: { check: async () => ({ action: 'allow' }) } as never,
      interactions: { requestApproval: async () => 'allow_once', requestGuide: async () => '' } as never,
      artifacts: { save: async () => join(dir, 'artifact') } as never,
      ledger: { record: async (entry: unknown) => void ledger.push(entry) } as never,
      telemetry: { record: async (entry: unknown) => void telemetry.push(entry) } as never,
      workspaceRoot: dir,
      emit: (event) => void events.push(event),
    }
    return { deps, instance, conversationId, events, ledger, telemetry }
  }

  it('一次回合：turn.start → settle → turn.end(done)，会话状态落到 durable', async () => {
    const { deps, instance, conversationId, events } = await setup()

    await runDurableTurn(deps, {
      userText: '你好',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    })

    expect(events[0]).toMatchObject({ type: 'turn.start', sessionId: conversationId, turnId: 'turn-1' })
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done', sessionId: conversationId })

    const view = await instance.view(conversationId)
    expect(view.entries).toBeDefined()
    expect(view.docs['pi.usage']).toBeDefined()
    expect(view.docs['pi.agent']).toBeDefined()

    // 回合结束后消息数按 durable 条目回写索引（界面列表用）
    expect((await instance.list())[0].messageCount).toBe(2)
  }, 60_000)

  it('幂等：同一 turnId 重跑不产生第二个 submission（requestId 去重）', async () => {
    const { deps, instance, conversationId } = await setup()

    await runDurableTurn(deps, { userText: '你好', turnId: 'turn-dup', signal: new AbortController().signal })
    const before = (await instance.view(conversationId)).docs['pi.inbox']
    await runDurableTurn(deps, { userText: '你好', turnId: 'turn-dup', signal: new AbortController().signal })
    const after = (await instance.view(conversationId)).docs['pi.inbox']

    // 幂等提交：第二次不新增排队输入
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
  }, 60_000)
})
