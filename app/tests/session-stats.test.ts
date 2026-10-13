import { describe, expect, it } from 'vitest'

import { computeSessionUsage } from '../src/main/session/stats'
import type { SessionLine } from '../src/main/session/types'

const usage = (input: number, output: number, cacheRead: number): SessionLine => ({
  type: 'usage',
  provider: 'p',
  model: 'm',
  input,
  output,
  cacheRead,
  durationMs: 10,
  status: 'success',
  createdAt: new Date().toISOString(),
})

describe('computeSessionUsage', () => {
  it('累计 token 并按最后一次调用计算上下文剩余', () => {
    const stats = computeSessionUsage([usage(100, 20, 40), usage(200, 30, 60)], 1000)
    expect(stats.calls).toBe(2)
    expect(stats.inputTokens).toBe(300)
    expect(stats.outputTokens).toBe(50)
    expect(stats.cacheReadTokens).toBe(100)
    expect(stats.cacheHitRate).toBeCloseTo(100 / 300)
    // 最后一次输入+输出 = 230 / 1000 → 剩余 77%
    expect(stats.contextRemainingPercent).toBeCloseTo(77)
  })

  it('无 usage 行时返回 100% 剩余', () => {
    const stats = computeSessionUsage([], 1000)
    expect(stats.calls).toBe(0)
    expect(stats.cacheHitRate).toBe(0)
    expect(stats.contextRemainingPercent).toBe(100)
  })

  it('剩余上下文不会为负', () => {
    const stats = computeSessionUsage([usage(2000, 500, 0)], 1000)
    expect(stats.contextRemainingPercent).toBe(0)
  })
})
