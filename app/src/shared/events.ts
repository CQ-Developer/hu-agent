/** 主进程 -> UI 的事件流（design 5.2.1）。主进程与渲染进程共用。 */

export interface UsageInfo {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ToolCallInfo {
  id: string
  name: string
  input: unknown
}

export type ToolStatusView = 'ok' | 'error' | 'denied' | 'timeout'

export type TurnStopReason = 'done' | 'cancelled' | 'max_steps' | 'error'

export interface ToolResultView {
  id: string
  name: string
  status: ToolStatusView
  output: string
  durationMs: number
  truncated?: boolean
  artifactPath?: string
}

interface Base {
  sessionId: string
  turnId: string
}

export type AgentEvent =
  | (Base & { type: 'turn.start' })
  | (Base & { type: 'assistant.delta'; text: string })
  | (Base & { type: 'reasoning.delta'; text: string })
  | (Base & { type: 'tool.call'; call: ToolCallInfo })
  | (Base & { type: 'tool.result'; result: ToolResultView })
  | (Base & { type: 'usage.update'; usage: UsageInfo; provider: string; model: string })
  | (Base & { type: 'turn.end'; stopReason: TurnStopReason; error?: string })
