/** 会话 JSONL 行协议（design 5.3.2）。 */

import type { ReasoningEffort } from '../model/types'

export type ToolStatus = 'ok' | 'error' | 'denied' | 'timeout'

export interface SessionMetaLine {
  type: 'meta'
  v: 1
  sessionId: string
  createdAt: string
  appVersion?: string
}

export interface TextPart {
  type: 'text'
  text: string
}

/** 思考内容（design 5.3.2）：仅存档展示，不回传给模型（Anthropic 工具续轮除外） */
export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /** Anthropic 扩展思考的签名，回传工具结果时必需 */
  signature?: string
}

export type MessagePart = TextPart | ReasoningPart

export interface MessageLine {
  type: 'message'
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: MessagePart[]
  createdAt: string
}

export interface ToolCallLine {
  type: 'tool_call'
  id: string
  name: string
  args: unknown
  turnId: string
  createdAt: string
}

export interface ToolResultLine {
  type: 'tool_result'
  id: string
  status: ToolStatus
  output: string
  durationMs: number
  truncated?: boolean
  artifactPath?: string
  createdAt: string
}

export interface UsageLine {
  type: 'usage'
  provider: string
  model: string
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  durationMs: number
  status: 'success' | 'error'
  purpose?: 'primary' | 'fast'
  createdAt: string
}

export interface SummaryLine {
  type: 'summary'
  text: string
  fromLine: number
  toLine: number
  model?: string
  createdAt: string
}

export interface CheckpointLine {
  type: 'checkpoint'
  name: string
  line: number
  note?: string
  createdAt: string
}

/** 会话级选项：模型选择与思考强度（design 5.2.6）；后写入的覆盖先写入的。 */
export interface SessionOptionsLine {
  type: 'session_options'
  model?: string
  reasoningEffort?: ReasoningEffort
  createdAt: string
}

export interface ErrorLine {
  type: 'error'
  code: string
  message: string
  detail?: unknown
  createdAt: string
}

export type SessionLine =
  | SessionMetaLine
  | MessageLine
  | ToolCallLine
  | ToolResultLine
  | UsageLine
  | SummaryLine
  | CheckpointLine
  | SessionOptionsLine
  | ErrorLine

export interface SessionMeta {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface SessionIndex {
  sessions: SessionMeta[]
}
