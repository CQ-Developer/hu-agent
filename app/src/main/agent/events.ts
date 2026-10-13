/** Agent 事件流（主进程 -> UI，design 5.2.1）。 */

import type { TokenUsage, ToolCall } from '../model/types'
import type { ToolStatus } from '../session/types'

export type TurnStopReason = 'done' | 'cancelled' | 'max_steps' | 'error'

export interface AgentEventBase {
  sessionId: string
  turnId: string
}

export interface ToolResultPayload {
  id: string
  name: string
  status: ToolStatus
  output: string
  durationMs: number
  truncated?: boolean
  artifactPath?: string
}

export type AgentEvent =
  | (AgentEventBase & { type: 'turn.start' })
  | (AgentEventBase & { type: 'assistant.delta'; text: string })
  | (AgentEventBase & { type: 'reasoning.delta'; text: string })
  | (AgentEventBase & { type: 'tool.call'; call: ToolCall })
  | (AgentEventBase & { type: 'tool.result'; result: ToolResultPayload })
  | (AgentEventBase & { type: 'usage.update'; usage: TokenUsage; provider: string; model: string })
  | (AgentEventBase & { type: 'turn.end'; stopReason: TurnStopReason; error?: string })
