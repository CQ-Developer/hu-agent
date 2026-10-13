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

export interface ApprovalRequestView {
  id: string
  sessionId: string
  turnId: string
  toolName: string
  category: 'read' | 'write' | 'exec' | 'interact' | 'mcp'
  summary: string
  paths: string[]
  command?: string
  /** 授权卡片上"始终允许"的范围描述 */
  scopeHint: string
}

export interface GuideOptionView {
  label: string
  value: string
  description?: string
}

export interface GuideRequestView {
  id: string
  sessionId: string
  turnId: string
  question: string
  options: GuideOptionView[]
  recommended?: string
  allowFreeText: boolean
}

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
  | (Base & { type: 'tool.approval_required'; request: ApprovalRequestView })
  | (Base & { type: 'ask_guide'; request: GuideRequestView })
  | (Base & { type: 'session.compacted' })
  | (Base & { type: 'usage.update'; usage: UsageInfo; provider: string; model: string })
  | (Base & { type: 'turn.end'; stopReason: TurnStopReason; error?: string })
