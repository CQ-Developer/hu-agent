/**
 * pi-durable 运行期状态 → 我们的 AgentEvent（机械投影，R1）。
 *
 * 数据来源与形状来自真实模型勘察（`tests/integration/pi_durable_live_real.test.ts`）：
 * - `live.generation.message.content[]`：追加式的块（`thinking` / `text` / `toolCall`），
 *   因此增量 = 本次累计内容相对上次的**后缀**；
 * - `live.tools[]`：`{ callId, name, taskId, status: 'pending'|'running'|'done', entry? }`，
 *   工具卡片状态机由它驱动；工具参数从 generation 消息的 `toolCall` 块里取（callId 对齐）；
 * - done 之后的结果输出需从 `entries` 里按 `entry` 读（本模块支持传入 entries 查找）。
 *
 * 本模块只做投影：不发起运行、不写存储，也不改变语义（停止原因与落库由循环负责）。
 */

import type { AgentEvent, ToolStatusView } from '../../shared/events'

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
}

interface LiveTool {
  callId?: string
  name?: string
  status?: string
  entry?: number
}

interface LiveGeneration {
  attempt?: number
  message?: { content?: ContentBlock[]; usage?: unknown; stopReason?: string }
}

export interface LiveState {
  run?: { taskId?: number; inputs?: number[] }
  generation?: LiveGeneration
  tools?: LiveTool[]
}

export interface ProjectionState {
  /** 已发出的文本/思考长度（用于计算增量后缀） */
  textLength: number
  reasoningLength: number
  /** callId → 已发出的状态（避免重复发 tool.call） */
  toolStatus: Map<string, string>
  /** 已发出结果的 callId */
  resultSent: Set<string>
  /** callId → 参数（来自 generation 的 toolCall 块） */
  toolArgs: Map<string, unknown>
}

export function createProjectionState(): ProjectionState {
  return { textLength: 0, reasoningLength: 0, toolStatus: new Map(), resultSent: new Set(), toolArgs: new Map() }
}

export interface ProjectionContext {
  sessionId: string
  turnId: string
  provider: string
  model: string
  /** 被治理层拒绝/超时的调用（拒绝状态由我们补，pi 不为被 block 的调用跑 afterTool） */
  denials?: { get(toolCallId: string): { status: 'denied' | 'timeout'; reason?: string } | undefined }
}

interface EntryLike {
  id?: number
  kind?: string
  model?: Array<{ role?: string; content?: unknown; isError?: boolean; toolName?: string }>
}

function blockText(content: unknown): { text: string; isError: boolean; toolName: string } {
  if (typeof content === 'string') return { text: content, isError: false, toolName: '' }
  if (!Array.isArray(content)) return { text: '', isError: false, toolName: '' }
  const text = content
    .map((item) => {
      const block = item as { type?: string; text?: string }
      return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
  return { text, isError: false, toolName: '' }
}

function usageFrom(value: unknown): { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number } | null {
  if (!value || typeof value !== 'object') return null
  const usage = value as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  if (typeof usage.input !== 'number' || typeof usage.output !== 'number') return null
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.cacheRead ? { cacheReadTokens: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cacheWriteTokens: usage.cacheWrite } : {}),
  }
}

/**
 * 把一次 `pi.live` 快照投影成事件。调用方每次 viewState 更新时调用一次，返回本次新增的事件。
 */
export function projectLive(
  live: LiveState | undefined,
  state: ProjectionState,
  ctx: ProjectionContext,
  entries: EntryLike[] = [],
): AgentEvent[] {
  const events: AgentEvent[] = []
  const base = { sessionId: ctx.sessionId, turnId: ctx.turnId }
  const content = live?.generation?.message?.content ?? []

  // 1) 工具参数：从 generation 的 toolCall 块收集（callId 与 live.tools 对齐）
  let text = ''
  let reasoning = ''
  for (const block of content) {
    if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking
    if (block.type === 'text' && typeof block.text === 'string') text += block.text
    if (block.type === 'toolCall' && typeof block.id === 'string') state.toolArgs.set(block.id, block.arguments)
  }

  // 2) 流式增量：追加式内容的后缀
  if (reasoning.length > state.reasoningLength) {
    events.push({ ...base, type: 'reasoning.delta', text: reasoning.slice(state.reasoningLength) })
    state.reasoningLength = reasoning.length
  }
  if (text.length > state.textLength) {
    events.push({ ...base, type: 'assistant.delta', text: text.slice(state.textLength) })
    state.textLength = text.length
  }

  // 3) 用量（每次快照都带最新累计值，直接透出）
  const usage = usageFrom(live?.generation?.message?.usage)
  if (usage) events.push({ ...base, type: 'usage.update', usage, provider: ctx.provider, model: ctx.model })

  // 4) 工具状态机
  for (const tool of live?.tools ?? []) {
    const callId = tool.callId
    const name = tool.name ?? ''
    if (!callId) continue
    const status = tool.status ?? 'pending'

    if (!state.toolStatus.has(callId)) {
      state.toolStatus.set(callId, status)
      events.push({ ...base, type: 'tool.call', call: { id: callId, name, input: state.toolArgs.get(callId) } })
    } else {
      state.toolStatus.set(callId, status)
    }

    if (status === 'done' && !state.resultSent.has(callId)) {
      state.resultSent.add(callId)
      const denial = ctx.denials?.get(callId)
      const entry = entries.find((item) => item.id === tool.entry)
      const message = entry?.model?.[0]
      const result = blockText(message?.content)
      const statusView: ToolStatusView = denial?.status ?? (message?.isError ? 'error' : 'ok')
      events.push({
        ...base,
        type: 'tool.result',
        result: {
          id: callId,
          name: name || message?.toolName || '',
          status: statusView,
          output: denial?.reason && result.text.length === 0 ? denial.reason : result.text,
          durationMs: 0,
        },
      })
    }
  }

  return events
}
