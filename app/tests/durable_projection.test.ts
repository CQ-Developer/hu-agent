/**
 * 投影层测试（R1）：用**真实模型勘察时捕获的运行期帧**作为 fixture，零网络、确定性。
 *
 * 帧来源：`tests/integration/pi_durable_live_real.test.ts` 实测输出（见 ADR-0006 的读取面表）。
 * 断言的是界面真正消费的东西：流式增量（后缀）、工具卡片状态机、用量透出、拒绝状态优先。
 */

import { describe, expect, it } from 'vitest'

import { createProjectionState, projectLive, type LiveState } from '../src/main/agent/durable_projection'
import type { AgentEvent } from '../src/shared/events'

const ctx = { sessionId: 's1', turnId: 't1', provider: 'token-hub', model: 'deepseek-v4.1-flash' }

function frame(partial: Partial<LiveState>): LiveState {
  return { run: { taskId: 9, inputs: [8] }, ...partial }
}

describe('pi.live → AgentEvent 投影', () => {
  it('按追加式内容输出增量后缀（思考与正文各一次）', () => {
    const state = createProjectionState()

    const first = projectLive(
      frame({ generation: { attempt: 1, message: { content: [{ type: 'thinking', thinking: '让我想' }] } } }),
      state,
      ctx,
    )
    expect(first).toEqual([{ sessionId: 's1', turnId: 't1', type: 'reasoning.delta', text: '让我想' }])

    const second = projectLive(
      frame({
        generation: {
          attempt: 1,
          message: { content: [{ type: 'thinking', thinking: '让我想一下' }, { type: 'text', text: '好的' }] },
        },
      }),
      state,
      ctx,
    )
    expect(second).toEqual([
      { sessionId: 's1', turnId: 't1', type: 'reasoning.delta', text: '一下' },
      { sessionId: 's1', turnId: 't1', type: 'assistant.delta', text: '好的' },
    ])
  })

  it('工具状态机：pending 时发 tool.call（参数从 toolCall 块取），done 时发 tool.result 并读 entries', () => {
    const state = createProjectionState()
    const generation = {
      attempt: 1,
      message: {
        content: [
          { type: 'text', text: '先回显' },
          { type: 'toolCall', id: 'call_1', name: 'echo', arguments: { text: 'hi' } },
        ],
      },
    }

    const callEvents = projectLive(frame({ generation, tools: [{ callId: 'call_1', name: 'echo', status: 'pending' }] }), state, ctx)
    expect(callEvents.filter((event) => event.type === 'tool.call')).toEqual([
      { sessionId: 's1', turnId: 't1', type: 'tool.call', call: { id: 'call_1', name: 'echo', input: { text: 'hi' } } },
    ])

    // running 不重复发 tool.call
    const runningEvents = projectLive(frame({ generation, tools: [{ callId: 'call_1', name: 'echo', status: 'running' }] }), state, ctx)
    expect(runningEvents.filter((event) => event.type === 'tool.call')).toEqual([])

    // done：从 entries 里按 entry 读结果内容
    const entries = [
      {
        id: 13,
        kind: 'pi.toolResult',
        model: [{ role: 'toolResult', toolName: 'echo', content: [{ type: 'text', text: 'echo:hi' }], isError: false }],
      },
    ]
    const doneEvents = projectLive(
      frame({ generation, tools: [{ callId: 'call_1', name: 'echo', status: 'done', entry: 13 }] }),
      state,
      ctx,
      entries,
    )
    const results = doneEvents.filter((event) => event.type === 'tool.result') as Array<Extract<AgentEvent, { type: 'tool.result' }>>
    expect(results).toHaveLength(1)
    expect(results[0].result).toMatchObject({ id: 'call_1', name: 'echo', status: 'ok', output: 'echo:hi' })

    // 再收到同一帧不重复发结果
    const repeat = projectLive(
      frame({ generation, tools: [{ callId: 'call_1', name: 'echo', status: 'done', entry: 13 }] }),
      state,
      ctx,
      entries,
    )
    expect(repeat.filter((event) => event.type === 'tool.result')).toEqual([])
  })

  it('用量随快照透出；拒绝状态优先于工具自身状态', () => {
    const state = createProjectionState()
    const denials = new Map<string, { status: 'denied' | 'timeout'; reason?: string }>([
      ['call_denied', { status: 'denied', reason: '当前权限策略拒绝该操作' }],
    ])

    const events = projectLive(
      frame({
        generation: {
          attempt: 1,
          message: {
            content: [],
            usage: { input: 120, output: 30, cacheRead: 64, cacheWrite: 0 },
            stopReason: 'pending',
          },
        },
        tools: [{ callId: 'call_denied', name: 'shell', status: 'done', entry: 99 }],
      }),
      state,
      { ...ctx, denials },
      [{ id: 99, kind: 'pi.toolResult', model: [{ role: 'toolResult', content: [], isError: true }] }],
    )

    expect(events.find((event) => event.type === 'usage.update')).toMatchObject({
      type: 'usage.update',
      usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 64 },
      provider: 'token-hub',
      model: 'deepseek-v4.1-flash',
    })
    const result = events.find((event) => event.type === 'tool.result') as Extract<AgentEvent, { type: 'tool.result' }>
    expect(result.result).toMatchObject({ status: 'denied', output: '当前权限策略拒绝该操作' })
  })

  it('空快照（settle 后 pi.live 为 {}）不产生事件', () => {
    const state = createProjectionState()
    expect(projectLive({}, state, ctx)).toEqual([])
    expect(projectLive(undefined, state, ctx)).toEqual([])
  })
})
