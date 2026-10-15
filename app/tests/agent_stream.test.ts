/**
 * 回合流式状态纯函数测试（design 5.2；P3 从 App.tsx 抽出的机械逻辑）。
 *
 * 这些行为此前只存在于渲染组件里、没有测试：增量累计、工具卡插入/补全、turn.end 落消息、
 * usage 实时累加。这里按旧行为逐条固定，防止后续改动用例回归。
 */

import { describe, expect, it } from 'vitest'

import {
  accumulateUsage,
  appendStreamDelta,
  appendToolCall,
  contextWindowFor,
  EMPTY_STREAM,
  patchToolResult,
  streamMessageItem,
  userMessageItem,
} from '../src/renderer/src/state/agent_stream'
import type { SessionItemView, SessionUsageView } from '../src/shared/ipc'

const NOW = '2026-01-01T00:00:00.000Z'

describe('appendStreamDelta', () => {
  it('文本与思考各自累计，且不修改原缓冲', () => {
    const first = appendStreamDelta(EMPTY_STREAM, 'text', '你好')
    const second = appendStreamDelta(first, 'reasoning', '想一下')
    const third = appendStreamDelta(second, 'text', '，世界')

    expect(third).toEqual({ text: '你好，世界', reasoning: '想一下' })
    expect(first).toEqual({ text: '你好', reasoning: '' })
    expect(EMPTY_STREAM).toEqual({ text: '', reasoning: '' })
  })
})

describe('streamMessageItem', () => {
  it('无内容返回 null；有思考无文本时也生成消息且带 reasoning', () => {
    expect(streamMessageItem(EMPTY_STREAM, 'm1', NOW)).toBeNull()
    expect(streamMessageItem({ text: '', reasoning: '想' }, 'm1', NOW)).toEqual({
      kind: 'message',
      id: 'm1',
      role: 'assistant',
      text: '',
      reasoning: '想',
      createdAt: NOW,
    })
  })

  it('有文本时带 text；纯文本不带 reasoning 字段', () => {
    const item = streamMessageItem({ text: '回答', reasoning: '想' }, 'm1', NOW)
    expect(item).toMatchObject({ text: '回答', reasoning: '想' })
    const plain = streamMessageItem({ text: '回答', reasoning: '' }, 'm2', NOW)
    expect(plain).not.toHaveProperty('reasoning')
  })
})

describe('appendToolCall', () => {
  const existing: SessionItemView[] = [userMessageItem('问题', 'u1', NOW)]

  it('缓冲有内容：先落助手消息再插工具卡', () => {
    const items = appendToolCall(existing, { text: '先回显', reasoning: '想' }, { id: 'c1', name: 'echo', input: { a: 1 } }, {
      messageId: 'stream_t1',
      createdAt: NOW,
    })
    expect(items).toHaveLength(3)
    expect(items[1]).toMatchObject({ kind: 'message', id: 'stream_t1', role: 'assistant', text: '先回显', reasoning: '想' })
    expect(items[2]).toMatchObject({ kind: 'tool', id: 'c1', name: 'echo', input: { a: 1 }, createdAt: NOW })
  })

  it('缓冲为空：只插工具卡', () => {
    const items = appendToolCall(existing, EMPTY_STREAM, { id: 'c1', name: 'echo', input: {} }, {
      messageId: 'stream_t1',
      createdAt: NOW,
    })
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ kind: 'tool', id: 'c1' })
  })
})

describe('patchToolResult', () => {
  const tool: SessionItemView = { kind: 'tool', id: 'c1', name: 'echo', input: {}, createdAt: NOW }
  const text = userMessageItem('问题', 'u1', NOW)

  it('按 callId 补全状态与输出；其他条目原样保留', () => {
    const items = patchToolResult([text, tool], {
      id: 'c1',
      status: 'ok',
      output: 'echo:hi',
      durationMs: 12,
      truncated: true,
      artifactPath: '/tmp/a.txt',
    })
    expect(items[0]).toBe(text)
    expect(items[1]).toMatchObject({
      kind: 'tool',
      id: 'c1',
      status: 'ok',
      output: 'echo:hi',
      durationMs: 12,
      truncated: true,
      artifactPath: '/tmp/a.txt',
    })
  })

  it('找不到对应工具卡时不新增、不改动', () => {
    const items = patchToolResult([text, tool], { id: 'other', status: 'error', output: '', durationMs: 0 })
    expect(items).toHaveLength(2)
    expect(items[1]).toBe(tool)
  })
})

describe('userMessageItem', () => {
  it('生成用户消息条目', () => {
    expect(userMessageItem('你好', 'u1', NOW)).toEqual({
      kind: 'message',
      id: 'u1',
      role: 'user',
      text: '你好',
      createdAt: NOW,
    })
  })
})

describe('contextWindowFor', () => {
  const models = [
    { target: 'a/m1', providerId: 'a', name: 'm1', contextWindow: 1000, reasoningEffort: false },
    { target: 'b/m2', providerId: 'b', name: 'm2', contextWindow: 2000, reasoningEffort: false },
  ]

  it('按当前模型取窗口；找不到退回 fallback', () => {
    expect(contextWindowFor(models, { model: 'b/m2', reasoningEffort: 'off' }, 0)).toBe(2000)
    expect(contextWindowFor(models, { model: 'c/m3', reasoningEffort: 'off' }, 500)).toBe(500)
    expect(contextWindowFor(models, null, 500)).toBe(500)
  })
})

describe('accumulateUsage', () => {
  const prev: SessionUsageView = {
    calls: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheHitRate: 50 / 150,
    contextWindow: 1000,
    contextRemainingPercent: 80,
  }

  it('累加输入/输出/缓存与调用次数，并重算命中率（沿用渲染层既有口径 cacheRead/input）', () => {
    const next = accumulateUsage(prev, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 50 }, 1000)
    expect(next).toMatchObject({ calls: 2, inputTokens: 150, outputTokens: 30, cacheReadTokens: 100 })
    expect(next.cacheHitRate).toBeCloseTo(100 / 150, 6) // turn.end 会用 IPC 校准为服务端口径
  })

  it('上下文余量按本次输入+输出计算，夹在 0..100', () => {
    const small = accumulateUsage(prev, { inputTokens: 200, outputTokens: 0 }, 1000)
    expect(small.contextRemainingPercent).toBeCloseTo(80, 6)
    const over = accumulateUsage(prev, { inputTokens: 5000, outputTokens: 0 }, 1000)
    expect(over.contextRemainingPercent).toBe(0)
  })

  it('首次调用（prev 为空）与无窗口模型（contextWindow=0）的边界', () => {
    const first = accumulateUsage(null, { inputTokens: 10, outputTokens: 5 }, 0)
    expect(first).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5, contextWindow: 0 })
    expect(first.contextRemainingPercent).toBe(100)
  })
})
