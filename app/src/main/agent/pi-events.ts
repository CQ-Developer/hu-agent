/**
 * pi 事件 → 我们的 AgentEvent 映射（P1.2 引擎切换）。
 *
 * 这张映射表是**契约**：pi 的每一类事件都必须有明确归属——要么映射成我们的渲染事件，
 * 要么在 `UNMAPPED_PI_EVENTS` 里写明"按设计不映射"（见 tests/pi-events.test.ts 的完整性测试）。
 * 上游新增事件类型时，这个测试会失败，提醒我们补映射。
 *
 * 边界划分：
 * - 本模块只做"事件翻译"，不决定轮次何时结束；
 * - `turn.end` / `session.compacted` 由循环层发出（只有它知道停止原因：done/cancelled/max_steps/error）。
 */

import type { AgentEvent as PiAgentEvent } from '@earendil-works/pi-agent-core'

import type { TokenUsage } from '../model/types'
import type { AgentEvent, ToolResultPayload } from './events'

export interface PiEventContext {
  sessionId: string
  turnId: string
  provider: string
  model: string
}

/**
 * 按设计不映射的 pi 事件：
 * - `turn_start`：pi 的 turn = 一次模型调用 + 工具执行，我们的 `turn.start` 对应 `agent_start`（用户回合）；
 * - `message_start`：只有开始信号，内容通过 delta 事件到达；
 * - `tool_execution_update`：工具流式进度，我们的 UI 目前只展示最终结果（未来要进度条时在此补映射）；
 * - `turn_end`：轮次收尾由循环层与 `finishTurn` 决定，不直接对应渲染事件；
 * - `agent_end`：循环层在它之后发 `turn.end`（只有循环知道 done/cancelled/max_steps/error）。
 */
export const UNMAPPED_PI_EVENTS = [
  'turn_start',
  'message_start',
  'tool_execution_update',
  'turn_end',
  'agent_end',
] as const

/** pi 工具结果里我们关心的 details（由我们自己的工具写入，见 tools/*） */
interface ResultDetails {
  status?: ToolResultPayload['status']
  truncated?: boolean
  artifactPath?: string
}

function base<T extends Omit<AgentEvent, 'sessionId' | 'turnId'>>(ctx: PiEventContext, event: T): AgentEvent {
  return { ...event, sessionId: ctx.sessionId, turnId: ctx.turnId } as AgentEvent
}

/** 把 pi 的内容块数组拼成展示用文本（我们只渲染文本；图片等留待后续） */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object') {
        const candidate = block as { type?: string; text?: string }
        if (candidate.type === 'text' && typeof candidate.text === 'string') return candidate.text
      }
      return ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function isTokenUsage(value: unknown): value is { input: number; output: number; cacheRead?: number; cacheWrite?: number } {
  if (!value || typeof value !== 'object') return false
  const usage = value as { input?: unknown; output?: unknown }
  return typeof usage.input === 'number' && typeof usage.output === 'number'
}

/** pi 的 usage → 我们的 TokenUsage */
export function mapUsage(usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): TokenUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/** pi 的工具结果 → 我们的 ToolResultView（status 优先取我们工具自己写的 details.status） */
export function mapToolResult(event: {
  toolCallId: string
  toolName: string
  result?: unknown
  isError?: boolean
  durationMs?: number
}): ToolResultPayload {
  const result = (event.result ?? {}) as { content?: unknown; details?: ResultDetails }
  const details = result.details ?? {}
  const status: ToolResultPayload['status'] = details.status ?? (event.isError ? 'error' : 'ok')
  return {
    id: event.toolCallId,
    name: event.toolName,
    status,
    output: contentToText(result.content),
    durationMs: event.durationMs ?? 0,
    ...(details.truncated ? { truncated: true } : {}),
    ...(details.artifactPath ? { artifactPath: details.artifactPath } : {}),
  }
}

/** 翻译单个 pi 事件；返回空数组表示该事件按设计不产生渲染事件 */
export function mapPiEvent(event: PiAgentEvent, ctx: PiEventContext): AgentEvent[] {
  switch (event.type) {
    case 'agent_start':
      return [base(ctx, { type: 'turn.start' })]

    case 'message_update': {
      const inner = event.assistantMessageEvent
      if (inner.type === 'text_delta') return [base(ctx, { type: 'assistant.delta', text: inner.delta })]
      if (inner.type === 'thinking_delta') return [base(ctx, { type: 'reasoning.delta', text: inner.delta })]
      return []
    }

    case 'message_end': {
      const message = event.message as { role?: string; usage?: unknown }
      if (message.role !== 'assistant' || !isTokenUsage(message.usage)) return []
      return [
        base(ctx, {
          type: 'usage.update',
          usage: mapUsage(message.usage),
          provider: ctx.provider,
          model: ctx.model,
        }),
      ]
    }

    case 'tool_execution_start':
      return [
        base(ctx, {
          type: 'tool.call',
          call: { id: event.toolCallId, name: event.toolName, input: event.args },
        }),
      ]

    case 'tool_execution_end':
      return [base(ctx, { type: 'tool.result', result: mapToolResult(event) })]

    case 'agent_end':
    case 'turn_end':
      // 轮次收尾由循环层决定（它掌握 done/cancelled/max_steps/error）
      return []

    default:
      return []
  }
}
