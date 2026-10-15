/**
 * 回合流式状态 → 界面条目的纯函数（从 App.tsx 抽出，P3）。
 *
 * 这里只做数据变换，不碰 React/IPC，因此可单测；App.tsx 只负责把结果写进 state，
 * 以及 turn.end 后的 IPC 校准（那是副作用，留在组件里）。
 */

import type { ModelOptionView, SessionItemView, SessionOptionsView, SessionUsageView } from '@shared/ipc'

export interface StreamBuffer {
  text: string
  reasoning: string
}

export const EMPTY_STREAM: StreamBuffer = { text: '', reasoning: '' }

/** 追加流式增量（文本与思考各自累计）。 */
export function appendStreamDelta(buffer: StreamBuffer, kind: 'text' | 'reasoning', delta: string): StreamBuffer {
  return kind === 'text'
    ? { ...buffer, text: buffer.text + delta }
    : { ...buffer, reasoning: buffer.reasoning + delta }
}

/** 流式缓冲 → 助手消息条目；无内容返回 null（id/时间由调用方给，便于测试固定）。 */
export function streamMessageItem(buffer: StreamBuffer, id: string, createdAt: string): SessionItemView | null {
  if (!buffer.text && !buffer.reasoning) return null
  return {
    kind: 'message',
    id,
    role: 'assistant',
    text: buffer.text,
    ...(buffer.reasoning ? { reasoning: buffer.reasoning } : {}),
    createdAt,
  }
}

/** 工具调用到达：先把当前缓冲落成助手消息（若有内容），再插入工具卡。 */
export function appendToolCall(
  items: SessionItemView[],
  buffer: StreamBuffer,
  call: { id: string; name: string; input: unknown },
  options: { messageId: string; createdAt: string },
): SessionItemView[] {
  const message = streamMessageItem(buffer, options.messageId, options.createdAt)
  return [
    ...items,
    ...(message ? [message] : []),
    { kind: 'tool', id: call.id, name: call.name, input: call.input, createdAt: options.createdAt },
  ]
}

/** 工具结果到达：按 callId 补全工具卡；找不到对应卡片时原样返回。 */
export function patchToolResult(
  items: SessionItemView[],
  result: {
    id: string
    status: 'ok' | 'error' | 'denied' | 'timeout'
    output: string
    durationMs: number
    truncated?: boolean
    artifactPath?: string
  },
): SessionItemView[] {
  return items.map((item) =>
    item.kind === 'tool' && item.id === result.id
      ? {
          ...item,
          status: result.status,
          output: result.output,
          durationMs: result.durationMs,
          truncated: result.truncated,
          artifactPath: result.artifactPath,
        }
      : item,
  )
}

/** 用户消息条目（发送时立即上屏）。 */
export function userMessageItem(text: string, id: string, createdAt: string): SessionItemView {
  return { kind: 'message', id, role: 'user', text, createdAt }
}

/** 目标模型的上下文窗口；找不到时退回 fallback（通常是上一次统计值）。 */
export function contextWindowFor(
  models: ModelOptionView[],
  options: SessionOptionsView | null,
  fallback: number,
): number {
  return models.find((model) => model.target === options?.model)?.contextWindow ?? fallback
}

/** 用 usage.update 事件实时累加会话统计（turn.end 时再用 IPC 校准）。 */
export function accumulateUsage(
  prev: SessionUsageView | null,
  incoming: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  contextWindow: number,
): SessionUsageView {
  const calls = (prev?.calls ?? 0) + 1
  const inputTokens = (prev?.inputTokens ?? 0) + incoming.inputTokens
  const outputTokens = (prev?.outputTokens ?? 0) + incoming.outputTokens
  const cacheReadTokens = (prev?.cacheReadTokens ?? 0) + (incoming.cacheReadTokens ?? 0)
  const used = incoming.inputTokens + incoming.outputTokens
  return {
    calls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheHitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
    contextWindow,
    contextRemainingPercent: contextWindow > 0 ? Math.max(0, Math.min(1, 1 - used / contextWindow)) * 100 : 100,
  }
}
