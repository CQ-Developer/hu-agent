/** 会话用量统计（design 5.2.6）：用于输入框上方的 token / 缓存 / 上下文指示。 */

import type { SessionLine } from './types'

export interface SessionUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** 缓存命中率 = cacheRead / input（input 含缓存部分） */
  cacheHitRate: number
  contextWindow: number
  /** 剩余上下文 = 1 - (最后一次输入 + 最后一次输出) / contextWindow */
  contextRemainingPercent: number
}

export function computeSessionUsage(lines: SessionLine[], contextWindow: number): SessionUsage {
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let lastInput = 0
  let lastOutput = 0

  for (const line of lines) {
    if (line.type !== 'usage') continue
    calls += 1
    inputTokens += line.input
    outputTokens += line.output
    cacheReadTokens += line.cacheRead ?? 0
    lastInput = line.input
    lastOutput = line.output
  }

  const cacheHitRate = inputTokens > 0 ? cacheReadTokens / inputTokens : 0
  const used = lastInput + lastOutput
  const contextRemainingPercent = contextWindow > 0 ? Math.max(0, Math.min(1, 1 - used / contextWindow)) * 100 : 100

  return {
    calls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheHitRate,
    contextWindow,
    contextRemainingPercent,
  }
}
