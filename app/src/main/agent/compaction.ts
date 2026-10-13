/** 历史压缩（design 5.2.3）：超过上下文阈值时用快速模型生成摘要，写入 summary 行。
 *
 * 摘要覆盖 [fromLine, toLine]（1 基行号），构建上下文时只保留 toLine 之后的消息。
 */

import type { ModelGateway } from '../model/gateway'
import type { LlmMessage, TokenUsage } from '../model/types'
import type { SessionStore } from '../session/store'
import type { SessionLine } from '../session/types'
import type { UsageLedger } from '../usage/ledger'

export const DEFAULT_KEEP_RECENT_MESSAGES = 8
export const COMPACT_THRESHOLD = 0.7

/** 粗略 token 估算（4 字符 ≈ 1 token）；真实用量以模型返回的 usage 为准。 */
export function estimateTokens(messages: LlmMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars += message.content.length
    if (message.role === 'assistant') {
      if (message.reasoning) chars += message.reasoning.text.length
      for (const call of message.toolCalls ?? []) {
        chars += call.name.length + JSON.stringify(call.input ?? {}).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

const SUMMARIZE_SYSTEM = [
  '你是对话压缩器。将下面的对话记录压缩为简体中文结构化摘要，不超过 800 token。',
  '必须保留：用户目标与需求、关键约束与偏好、已完成的改动（文件路径与要点）、当前状态、未决问题。',
  '不要输出寒暄或解释，只输出摘要正文。',
].join('\n')

export function renderTranscript(lines: SessionLine[], maxChars = 12_000): string {
  const parts: string[] = []
  let length = 0
  for (const line of lines) {
    let text = ''
    if (line.type === 'message') {
      text = line.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (text) text = `${line.role === 'user' ? '用户' : '助手'}：${text}`
    } else if (line.type === 'tool_call') {
      text = `[调用工具 ${line.name}]`
    } else if (line.type === 'tool_result') {
      const output = line.output.length > 300 ? `${line.output.slice(0, 300)}…` : line.output
      text = `[工具结果 ${line.status}] ${output}`
    }
    if (!text) continue
    if (length + text.length > maxChars) break
    parts.push(text)
    length += text.length
  }
  return parts.join('\n')
}

export interface CompactDeps {
  gateway: ModelGateway
  sessions: SessionStore
  ledger: UsageLedger
  /** 快速模型 target（"provider/model"）；缺省回退到当前会话模型 */
  fastTarget: string
  keepRecentMessages?: number
}

/** 执行一次压缩；返回是否成功写入摘要。 */
export async function compactHistory(
  deps: CompactDeps,
  sessionId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const { lines } = await deps.sessions.readLines(sessionId)

  // 上一次摘要覆盖到哪里
  let start = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line?.type === 'summary') {
      start = Math.min(line.toLine, lines.length)
      break
    }
  }

  const keep = deps.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES
  const messageIndexes: number[] = []
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index]?.type === 'message') messageIndexes.push(index)
  }
  if (messageIndexes.length <= keep) return false

  const cutLine = messageIndexes[messageIndexes.length - keep]
  if (cutLine === undefined || cutLine <= start) return false
  const transcript = renderTranscript(lines.slice(start, cutLine))
  if (!transcript.trim()) return false

  const { provider, model } = deps.gateway.resolve(deps.fastTarget)
  const startedAt = Date.now()
  let summaryText = ''
  let usage: TokenUsage | undefined
  for await (const event of deps.gateway.chat(
    { target: deps.fastTarget },
    [
      { role: 'system', content: SUMMARIZE_SYSTEM },
      { role: 'user', content: transcript },
    ],
    [],
    signal,
  )) {
    if (event.type === 'text_delta') summaryText += event.text
    else if (event.type === 'usage') usage = event.usage
  }
  if (!summaryText.trim()) return false

  const now = new Date().toISOString()
  const durationMs = Date.now() - startedAt
  // toLine 为 1 基：lines[cutLine - 1] 是被摘要覆盖的最后一行
  await deps.sessions.append(sessionId, {
    type: 'summary',
    text: summaryText.trim(),
    fromLine: start + 1,
    toLine: cutLine,
    model: model.name,
    createdAt: now,
  })
  await deps.sessions.append(sessionId, {
    type: 'usage',
    provider: provider.id,
    model: model.name,
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    cacheRead: usage?.cacheReadTokens,
    cacheWrite: usage?.cacheWriteTokens,
    durationMs,
    status: 'success',
    purpose: 'fast',
    createdAt: now,
  })
  await deps.ledger.record({
    ts: now,
    provider: provider.id,
    model: model.name,
    role: 'fast',
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    durationMs,
    status: 'success',
  })
  return true
}
