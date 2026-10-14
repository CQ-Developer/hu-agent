/**
 * durable 数据 → 界面视图的**纯映射**（R1 最后一批的机械核心）。
 *
 * 目标：把 pi-durable 的 entries / pi.usage / pi.agent 映射进**现有视图类型**
 * （`SessionMetaView` / `SessionItemView` / `SessionOptionsView` / `SessionUsageView`），
 * 这样渲染层一行都不用改。映射规则全部来自实测形状（ADR-0006 读取面表）。
 *
 * 刻意不依赖 `kind` 的取值分类：角色一律从条目内 pi 消息的 `role` 推断（更稳）。
 */

import type { CreateSessionOptions, SessionIndexEntry } from './durable'
import type {
  SessionItemView,
  SessionMetaView,
  SessionOptionsView,
  SessionUsageView,
} from '../../shared/ipc'
import type { ReasoningEffortView } from '../../shared/ipc'

interface ContentBlock {
  type?: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: unknown
}

interface MessageLike {
  role?: string
  content?: unknown
  timestamp?: number
  isError?: boolean
  toolName?: string
  toolCallId?: string
}

export interface EntryLike {
  id?: number
  kind?: string
  model?: MessageLike[]
}

export interface PiUsageLike {
  models?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>
  tools?: Record<string, unknown>
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      const block = item as ContentBlock
      return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function reasoningOf(value: unknown): string {
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      const block = item as ContentBlock
      return block.type === 'thinking' && typeof block.thinking === 'string' ? block.thinking : ''
    })
    .filter((part) => part.length > 0)
    .join('\n')
}

function toolCallsOf(value: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => item as ContentBlock)
    .filter((block) => block.type === 'toolCall' && typeof block.id === 'string')
    .map((block) => ({ id: block.id as string, name: block.name ?? '', input: block.arguments }))
}

function isoOf(timestamp: number | undefined, fallback: string): string {
  return typeof timestamp === 'number' ? new Date(timestamp).toISOString() : fallback
}

/** 视图索引条目 + 消息数 → 会话摘要（界面列表用） */
export function toSessionMeta(entry: SessionIndexEntry, messageCount: number): SessionMetaView {
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    messageCount,
  }
}

/**
 * pi 条目 → 界面条目。
 * 规则：从内层 pi 消息的 role 推断；system 跳过；assistant 里的 toolCall 块与随后的
 * toolResult 条目**按 callId 合并**成一张工具卡（先出现调用、后补结果）。
 */
export function toSessionItems(entries: EntryLike[], fallbackTime = new Date(0).toISOString()): SessionItemView[] {
  const items: SessionItemView[] = []
  const toolIndex = new Map<string, Extract<SessionItemView, { kind: 'tool' }>>()

  for (const entry of entries) {
    const message = entry.model?.[0]
    if (!message) continue
    const createdAt = isoOf(message.timestamp, fallbackTime)

    if (message.role === 'system') continue // 系统条目（提示/工具声明）不渲染

    if (message.role === 'user' || message.role === 'assistant') {
      const text = textOf(message.content)
      const reasoning = reasoningOf(message.content)
      if (text.length > 0 || reasoning.length > 0) {
        items.push({
          kind: 'message',
          id: String(entry.id ?? items.length),
          role: message.role,
          text,
          ...(reasoning ? { reasoning } : {}),
          createdAt,
        })
      }
      for (const call of toolCallsOf(message.content)) {
        const tool: Extract<SessionItemView, { kind: 'tool' }> = {
          kind: 'tool',
          id: call.id,
          name: call.name,
          input: call.input,
          createdAt,
        }
        toolIndex.set(call.id, tool)
        items.push(tool)
      }
      continue
    }

    if (message.role === 'toolResult') {
      const callId = message.toolCallId ?? ''
      const existing = callId ? toolIndex.get(callId) : undefined
      const patch = {
        ...(existing?.input !== undefined ? { input: existing.input } : { input: undefined }),
        name: message.toolName ?? existing?.name ?? '',
        status: (message.isError ? 'error' : 'ok') as 'error' | 'ok',
        output: textOf(message.content),
        createdAt: existing?.createdAt ?? createdAt,
      }
      if (existing) {
        Object.assign(existing, patch)
      } else {
        items.push({
          kind: 'tool',
          id: callId || String(entry.id ?? items.length),
          name: patch.name,
          input: patch.input,
          status: patch.status,
          output: patch.output,
          createdAt: patch.createdAt,
        })
      }
    }
  }

  return items
}

/** 会话统计用：助手条目数（pi 的用量文档不记调用次数，用助手消息条目数最贴近） */
export function countAssistantEntries(entries: EntryLike[]): number {
  return entries.filter((entry) => entry.model?.[0]?.role === 'assistant').length
}

const THINKING_TO_EFFORT: Record<string, ReasoningEffortView> = {
  off: 'off',
  minimal: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

/** pi.agent（已解析配置）→ 会话选项视图 */
export function toSessionOptions(agent: Record<string, unknown>): SessionOptionsView {
  const model = agent.model as { provider?: string; modelId?: string } | undefined
  const target = model?.provider && model.modelId ? `${model.provider}/${model.modelId}` : ''
  const level = typeof agent.thinkingLevel === 'string' ? agent.thinkingLevel : 'off'
  return { model: target, reasoningEffort: THINKING_TO_EFFORT[level] ?? 'off' }
}

/** 会话选项视图 → configure 的增量（我们只改这两个字段） */
export function fromSessionOptions(options: SessionOptionsView): {
  model?: { provider: string; modelId: string }
  thinkingLevel?: NonNullable<CreateSessionOptions['thinkingLevel']>
} {
  const slash = options.model.indexOf('/')
  const change: {
    model?: { provider: string; modelId: string }
    thinkingLevel?: NonNullable<CreateSessionOptions['thinkingLevel']>
  } = {}
  if (slash > 0) change.model = { provider: options.model.slice(0, slash), modelId: options.model.slice(slash + 1) }
  change.thinkingLevel = options.reasoningEffort === 'off' ? 'off' : options.reasoningEffort
  return change
}

/**
 * pi.usage + 上下文窗口 → 会话用量视图。
 * `calls` 由调用方给出（pi 的用量文档不记调用次数；用助手消息条目数最贴近）。
 */
export function toSessionUsage(
  usage: PiUsageLike,
  options: { calls: number; contextWindow: number; lastInputTokens?: number },
): SessionUsageView {
  const models = Object.values(usage.models ?? {})
  const inputTokens = models.reduce((sum, entry) => sum + (entry.input ?? 0), 0)
  const outputTokens = models.reduce((sum, entry) => sum + (entry.output ?? 0), 0)
  const cacheReadTokens = models.reduce((sum, entry) => sum + (entry.cacheRead ?? 0), 0)
  const billed = inputTokens + cacheReadTokens
  const contextWindow = options.contextWindow > 0 ? options.contextWindow : 0
  const used = options.lastInputTokens ?? inputTokens
  const remaining = contextWindow > 0 ? Math.max(0, Math.min(100, (1 - used / contextWindow) * 100)) : 0

  return {
    calls: options.calls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheHitRate: billed > 0 ? cacheReadTokens / billed : 0,
    contextWindow,
    contextRemainingPercent: remaining,
  }
}
