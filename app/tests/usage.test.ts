import { describe, expect, it } from 'vitest'

import { aggregateUsage, type UsageEntry } from '../src/main/usage/ledger'

const entry = (overrides: Partial<UsageEntry>): UsageEntry => ({
  ts: new Date().toISOString(),
  provider: 'openai',
  model: 'gpt-4o-mini',
  role: 'primary',
  inputTokens: 100,
  outputTokens: 20,
  durationMs: 500,
  status: 'success',
  ...overrides,
})

describe('aggregateUsage', () => {
  it('汇总总数与按模型分组', () => {
    const stats = aggregateUsage([
      entry({}),
      entry({ model: 'gpt-4o', inputTokens: 200, outputTokens: 50 }),
      entry({ status: 'error', errorCode: 'rate_limit', inputTokens: 0, outputTokens: 0 }),
    ])
    expect(stats.calls).toBe(3)
    expect(stats.errors).toBe(1)
    expect(stats.inputTokens).toBe(300)
    expect(stats.outputTokens).toBe(70)
    expect(stats.byModel['openai/gpt-4o']?.calls).toBe(1)
    expect(stats.byModel['openai/gpt-4o-mini']?.calls).toBe(2)
  })

  it('空账本返回零值', () => {
    const stats = aggregateUsage([])
    expect(stats).toMatchObject({ calls: 0, errors: 0, inputTokens: 0, outputTokens: 0 })
  })
})
