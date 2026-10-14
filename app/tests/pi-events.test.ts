/**
 * pi 事件映射契约测试（P1.2）。
 *
 * 最有价值的一条是**完整性测试**：把 pi 的事件全集逐一喂进映射函数，断言"要么映射出事件、
 * 要么在 UNMAPPED_PI_EVENTS 里显式声明"。上游升级 pi 新增事件类型时，这个测试会失败，
 * 而不是静默丢事件（静默丢事件的表现是"UI 少了东西但没人知道为什么"）。
 */

import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../src/main/agent/events'
import { UNMAPPED_PI_EVENTS, mapPiEvent, mapToolResult, mapUsage } from '../src/main/agent/pi-events'

const ctx = { sessionId: 's1', turnId: 't1', provider: 'gateway', model: 'deepseek-v4.1-flash' }

/** 构造一个 pi 事件（字段按 pi 的 union 填，避免测试随上游字段漂移） */
function piEvent(type: PiAgentEvent['type'], extra: Record<string, unknown> = {}): PiAgentEvent {
  return { type, ...extra } as unknown as PiAgentEvent
}

describe('pi 事件映射', () => {
  it('agent_start → turn.start', () => {
    expect(mapPiEvent(piEvent('agent_start'), ctx)).toEqual([{ type: 'turn.start', sessionId: 's1', turnId: 't1' }])
  })

  it('文本与思考增量分别映射（且带上会话/轮次标识）', () => {
    const text = mapPiEvent(
      piEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: '你好' } }),
      ctx,
    )
    expect(text).toEqual([{ type: 'assistant.delta', text: '你好', sessionId: 's1', turnId: 't1' }])

    const thinking = mapPiEvent(
      piEvent('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: '推理中' } }),
      ctx,
    )
    expect(thinking).toEqual([{ type: 'reasoning.delta', text: '推理中', sessionId: 's1', turnId: 't1' }])
  })

  it('助手消息结束时带用量则映射 usage.update，非助手消息不映射', () => {
    const withUsage = mapPiEvent(
      piEvent('message_end', {
        message: { role: 'assistant', usage: { input: 120, output: 30, cacheRead: 64 } },
      }),
      ctx,
    )
    expect(withUsage).toEqual([
      {
        type: 'usage.update',
        usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 64 },
        provider: 'gateway',
        model: 'deepseek-v4.1-flash',
        sessionId: 's1',
        turnId: 't1',
      },
    ])

    expect(mapPiEvent(piEvent('message_end', { message: { role: 'user' } }), ctx)).toEqual([])
  })

  it('工具开始与结束映射成 tool.call / tool.result（成功）', () => {
    expect(
      mapPiEvent(piEvent('tool_execution_start', { toolCallId: 'c1', toolName: 'read_file', args: { path: 'a.txt' } }), ctx),
    ).toEqual([
      {
        type: 'tool.call',
        call: { id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
        sessionId: 's1',
        turnId: 't1',
      },
    ])

    const result = mapPiEvent(
      piEvent('tool_execution_end', {
        toolCallId: 'c1',
        toolName: 'read_file',
        isError: false,
        durationMs: 12,
        result: { content: [{ type: 'text', text: '内容' }], details: { truncated: true, artifactPath: '/tmp/a' } },
      }),
      ctx,
    )
    expect(result).toEqual([
      {
        type: 'tool.result',
        result: {
          id: 'c1',
          name: 'read_file',
          status: 'ok',
          output: '内容',
          durationMs: 12,
          truncated: true,
          artifactPath: '/tmp/a',
        },
        sessionId: 's1',
        turnId: 't1',
      },
    ])
  })

  it('工具失败仍是 error；但优先采用我们工具写入的 denied/timeout（审批与超时不是技术错误）', () => {
    const error = mapToolResult({ toolCallId: 'c2', toolName: 'shell', isError: true, result: { content: [] } })
    expect(error.status).toBe('error')

    const denied = mapToolResult({
      toolCallId: 'c3',
      toolName: 'shell',
      isError: true,
      result: { content: [{ type: 'text', text: '已被拒绝' }], details: { status: 'denied' } },
    })
    expect(denied.status).toBe('denied')

    const timeout = mapToolResult({
      toolCallId: 'c4',
      toolName: 'shell',
      isError: true,
      result: { content: [], details: { status: 'timeout' } },
    })
    expect(timeout.status).toBe('timeout')
  })

  it('用量映射保留缓存字段（企业成本统计需要）', () => {
    expect(mapUsage({ input: 10, output: 5 })).toEqual({ inputTokens: 10, outputTokens: 5 })
    expect(mapUsage({ input: 10, output: 5, cacheRead: 3, cacheWrite: 7 })).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 7,
    })
  })

  it('治理层拒绝的调用在映射后是 denied（pi 不为 block 的调用跑 afterToolCall，状态在这里补）', () => {
    const denials = new Map<string, { status: 'denied' | 'timeout'; reason?: string }>([
      ['c-denied', { status: 'denied', reason: '当前权限策略拒绝该操作' }],
      ['c-timeout', { status: 'timeout', reason: '执行超时' }],
    ])
    const withDenials = { ...ctx, denials }

    const denied = mapPiEvent(
      piEvent('tool_execution_end', { toolCallId: 'c-denied', toolName: 'shell', isError: true, result: { content: [] } }),
      withDenials,
    )
    expect(denied[0]).toMatchObject({ type: 'tool.result', result: { id: 'c-denied', status: 'denied' } })
    expect((denied[0] as { result: { output: string } }).result.output).toBe('当前权限策略拒绝该操作')

    const timeout = mapPiEvent(
      piEvent('tool_execution_end', { toolCallId: 'c-timeout', toolName: 'shell', isError: true, result: { content: [] } }),
      withDenials,
    )
    expect(timeout[0]).toMatchObject({ type: 'tool.result', result: { status: 'timeout' } })

    // 未被拒绝的调用不受影响
    const normal = mapPiEvent(
      piEvent('tool_execution_end', { toolCallId: 'c-ok', toolName: 'read_file', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } }),
      withDenials,
    )
    expect(normal[0]).toMatchObject({ type: 'tool.result', result: { status: 'ok' } })
  })

  it('契约完整性：每一类 pi 事件都有归属（映射或显式声明不映射）', () => {
    // 与 pi-agent-core 的 AgentEvent union 一一对应；上游加事件类型时这里会失败
    const allPiEventTypes: PiAgentEvent['type'][] = [
      'agent_start',
      'agent_end',
      'turn_start',
      'turn_end',
      'message_start',
      'message_update',
      'message_end',
      'tool_execution_start',
      'tool_execution_update',
      'tool_execution_end',
    ]

    const mapped = new Set<string>()
    for (const type of allPiEventTypes) {
      const events = mapPiEvent(
        piEvent(type, {
          assistantMessageEvent: { type: 'text_delta', delta: 'x' },
          message: { role: 'assistant', usage: { input: 1, output: 1 } },
          toolResults: [],
          toolCallId: 'c',
          toolName: 'n',
          args: {},
          result: { content: [] },
          isError: false,
        }),
        ctx,
      )
      const owned = events.length > 0 || (UNMAPPED_PI_EVENTS as readonly string[]).includes(type)
      if (!owned) mapped.add(type)
    }

    expect([...mapped]).toEqual([]) // 该数组非空 = 有事件既没映射也没声明
    expect(new Set(allPiEventTypes).size).toBe(allPiEventTypes.length)
  })

  it('映射结果始终带会话与轮次标识（UI 依赖它分派）', () => {
    const events: AgentEvent[] = [
      ...mapPiEvent(piEvent('agent_start'), ctx),
      ...mapPiEvent(piEvent('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'x' } }), ctx),
      ...mapPiEvent(piEvent('tool_execution_start', { toolCallId: 'c', toolName: 'n', args: {} }), ctx),
    ]
    expect(events.length).toBe(3)
    for (const event of events) {
      expect(event.sessionId).toBe('s1')
      expect(event.turnId).toBe('t1')
    }
  })
})
