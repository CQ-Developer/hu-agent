/**
 * durable → 界面视图映射测试（R1 最后一批）。fixture 用实测捕获的条目形状（ADR-0006 读取面表）。
 */

import { describe, expect, it } from 'vitest'

import {
  fromSessionOptions,
  toSessionItems,
  toSessionMeta,
  toSessionOptions,
  toSessionUsage,
  type EntryLike,
} from '../src/main/session/durable_view'

const entries: EntryLike[] = [
  {
    id: 7,
    kind: 'pi.user',
    model: [{ role: 'user', content: '你好', timestamp: 1_791_983_155_272 }],
  },
  {
    id: 10,
    kind: 'pi.system',
    model: [{ role: 'system', content: '', timestamp: 1_791_983_155_281 }],
  },
  {
    id: 11,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '让我想一下' },
          { type: 'text', text: '先回显' },
          { type: 'toolCall', id: 'call_1', name: 'echo', arguments: { text: 'hi' } },
        ],
        timestamp: 1_791_983_156_000,
      },
    ],
  },
  {
    id: 13,
    kind: 'pi.toolResult',
    model: [
      {
        role: 'toolResult',
        toolName: 'echo',
        toolCallId: 'call_1',
        content: [{ type: 'text', text: 'echo:hi' }],
        isError: false,
        timestamp: 1_791_983_157_000,
      },
    ],
  },
  {
    id: 14,
    kind: 'pi.assistant',
    model: [
      { role: 'assistant', content: [{ type: 'text', text: '完成' }], timestamp: 1_791_983_158_000 },
    ],
  },
]

describe('durable → 视图映射', () => {
  it('条目 → 消息与工具卡（system 跳过、工具卡按 callId 合并结果）', () => {
    const items = toSessionItems(entries)
    expect(items.map((item) => `${item.kind}:${item.kind === 'message' ? item.role : item.name}`)).toEqual([
      'message:user',
      'message:assistant',
      'tool:echo',
      'message:assistant',
    ])

    const [user, assistant, tool, last] = items
    expect(user).toMatchObject({ kind: 'message', role: 'user', text: '你好' })
    expect(assistant).toMatchObject({ kind: 'message', role: 'assistant', text: '先回显', reasoning: '让我想一下' })
    expect(tool).toMatchObject({
      kind: 'tool',
      id: 'call_1',
      name: 'echo',
      input: { text: 'hi' },
      status: 'ok',
      output: 'echo:hi',
    })
    expect(last).toMatchObject({ kind: 'message', role: 'assistant', text: '完成' })
  })

  it('会话摘要：索引字段直传，消息数由调用方给出', () => {
    const meta = toSessionMeta(
      {
        id: 'c1',
        title: '第一会话',
        workspaceId: 'ws_1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T01:00:00.000Z',
      },
      3,
    )
    expect(meta).toEqual({
      id: 'c1',
      title: '第一会话',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T01:00:00.000Z',
      messageCount: 3,
    })
  })

  it('会话选项：pi.agent → 视图，并可反向生成 configure 增量', () => {
    const view = toSessionOptions({ model: { provider: 'token-hub', modelId: 'deepseek-v4.1-flash' }, thinkingLevel: 'high' })
    expect(view).toEqual({ model: 'token-hub/deepseek-v4.1-flash', reasoningEffort: 'high' })
    expect(fromSessionOptions(view)).toEqual({
      model: { provider: 'token-hub', modelId: 'deepseek-v4.1-flash' },
      thinkingLevel: 'high',
    })

    // 未支持的 thinking 档位收敛到 off/high（界面只有三档）
    expect(toSessionOptions({ thinkingLevel: 'max' }).reasoningEffort).toBe('high')
    expect(toSessionOptions({ thinkingLevel: 'minimal' }).reasoningEffort).toBe('off')
  })

  it('用量：多模型求和、缓存命中率与上下文余量', () => {
    const usage = {
      models: {
        'token-hub/deepseek-v4.1-flash': { input: 480, output: 102, cacheRead: 256, cacheWrite: 0 },
        'faux/faux-1': { input: 20, output: 8, cacheRead: 4, cacheWrite: 0 },
      },
    }
    const view = toSessionUsage(usage, { calls: 2, contextWindow: 100_000, lastInputTokens: 25_000 })
    expect(view.calls).toBe(2)
    expect(view.inputTokens).toBe(500)
    expect(view.outputTokens).toBe(110)
    expect(view.cacheReadTokens).toBe(260)
    expect(view.cacheHitRate).toBeCloseTo(260 / 760, 5)
    expect(view.contextWindow).toBe(100_000)
    expect(view.contextRemainingPercent).toBeCloseTo(75, 5)
  })
})
