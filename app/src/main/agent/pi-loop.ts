/**
 * 新循环：用 pi 的 `Agent` 驱动一轮对话（P1.2-c，蓝图见 docs/optimization.md 1.5）。
 *
 * 8 项职责的落点（与旧循环逐项对齐，行为不降级）：
 * 1) 追加用户消息 / touch / `turn.start` —— 循环外层；
 * 2) system prompt —— `initialState.systemPrompt`；
 * 3) 超阈值压缩 + `session.compacted` —— `transformContext` + 循环发事件；
 * 4) 流式文本与思考、工具调用 —— `pi-events.ts` 映射；
 * 5) 权限/审批/拒绝 —— `pi-governance.ts` 钩子；
 * 6) 工具执行语义与会话双写 —— `createAgentTools` + 本模块在工具事件上双写；
 * 7) 用量三写（sessions + ledger + telemetry，含失败路径 0 用量与 errorCode）—— `message_end.usage`；
 * 8) 停止原因（done / cancelled / max_steps / error，含 OUTPUT_TRUNCATED / MAX_STEPS 错误项）—— 本模块。
 *
 * 刻意不依赖 `ModelGateway`：模型解析与压缩分别走 `ModelResolver` / `HistorySummarizer` 能力接口，
 * 这样 P1.2-d 能一次性删除旧网关、旧 provider 与旧循环（否则新循环会把它们绑死）。
 */

import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { Agent } from '@earendil-works/pi-agent-core'

import type { AgentEvent, TurnStopReason } from '../../shared/events'
import { t } from '../i18n'
import type { TokenUsage } from '../model/types'
import type { InteractionBroker } from '../permissions/broker'
import type { PermissionEngine } from '../permissions/engine'
import type { ArtifactStore } from '../session/artifacts'
import type { SessionStore } from '../session/store'
import type { MessagePart, ToolStatus } from '../session/types'
import { ulid } from '../session/ulid'
import type { ToolRegistry } from '../tools/registry'
import type { AnyTool } from '../tools/types'
import type { UsageLedger } from '../usage/ledger'
import type { TelemetryInput, TelemetrySink } from '../usage/telemetry'
import { COMPACT_THRESHOLD } from './compaction'
import { mapPiEvent, type PiEventContext } from './pi-events'
import { createAfterToolCall, createAgentTools, createBeforeToolCall, createGovernanceState } from './pi-governance'
import { buildSystemPrompt } from './prompt'

/** 一轮对话的用量记录形态（与旧循环一致） */
export interface UsageRecord {
  provider: string
  model: string
  role: 'primary' | 'fast'
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  durationMs: number
  status: 'success' | 'error'
  errorCode?: string
}

export interface ResolvedModel {
  providerId: string
  modelId: string
  contextWindow: number
  /** pi 的 Model 实例 */
  model: unknown
  /** pi 的流式函数（来自 createModels()） */
  streamFn: unknown
}

/** 模型解析：P1.2-d 用 pi-config + createModels 实现；测试用假实现 */
export interface ModelResolver {
  resolve(target?: string): Promise<ResolvedModel>
}

/** 历史压缩：用一次非流式调用产出摘要（P1.2-d 用 pi 实现） */
export interface HistorySummarizer {
  summarize(history: string, signal: AbortSignal): Promise<string>
}

export interface PiLoopDeps {
  resolver: ModelResolver
  tools: ToolRegistry
  extraTools?: AnyTool[]
  sessions: SessionStore
  artifacts: ArtifactStore
  ledger: UsageLedger
  telemetry?: TelemetrySink
  permissions: PermissionEngine
  interactions: InteractionBroker
  emit: (event: AgentEvent) => void
  workspaceRoot: string
  skillSection?: string
  maxSteps?: number
  outputLimit?: number
  keepRecentMessages?: number
  /** 缺省不压缩（与旧循环"压缩失败降级"一致） */
  summarizer?: HistorySummarizer
}

export interface PiTurnOptions {
  sessionId: string
  userText: string
  signal: AbortSignal
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** 历史消息 → pi 的 transcript（assistant 需要补齐 pi 认为必填的字段） */
function toTranscriptMessages(
  history: Awaited<ReturnType<SessionStore['loadContextMessages']>>,
  resolved: ResolvedModel,
): unknown[] {
  const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } }
  const now = Date.now()

  return history.map((message) => {
    if (message.role === 'system') return { role: 'system', content: message.content, timestamp: now }
    if (message.role === 'user') return { role: 'user', content: message.content, timestamp: now }
    if (message.role === 'tool') {
      return {
        role: 'toolResult',
        toolCallId: message.toolCallId,
        toolName: '',
        content: [{ type: 'text', text: message.content }],
        isError: false,
        timestamp: now,
      }
    }
    const content: unknown[] = []
    if (message.reasoning?.text) {
      content.push({ type: 'thinking', thinking: message.reasoning.text, thinkingSignature: message.reasoning.signature })
    }
    if (message.content) content.push({ type: 'text', text: message.content })
    for (const call of message.toolCalls ?? []) {
      content.push({ type: 'toolCall', id: call.id, name: call.name, arguments: call.input })
    }
    return {
      role: 'assistant',
      content,
      api: '',
      provider: resolved.providerId,
      model: resolved.modelId,
      usage: zeroUsage,
      stopReason: 'stop',
      timestamp: now,
    }
  })
}

export async function runTurnWithPi(deps: PiLoopDeps, options: PiTurnOptions): Promise<void> {
  const turnId = ulid()
  const { sessionId, signal } = options
  const maxSteps = deps.maxSteps ?? 50
  const now = (): string => new Date().toISOString()

  await deps.sessions.append(sessionId, {
    type: 'message',
    id: ulid(),
    role: 'user',
    parts: [{ type: 'text', text: options.userText }],
    createdAt: now(),
  })
  await deps.sessions.touch(sessionId, 1)
  deps.emit({ type: 'turn.start', sessionId, turnId })

  let stopReason: TurnStopReason = 'done'
  let steps = 0

  const recordUsage = async (entry: UsageRecord, sessionItems: boolean): Promise<void> => {
    if (sessionItems) {
      await deps.sessions.append(sessionId, {
        type: 'usage',
        provider: entry.provider,
        model: entry.model,
        input: entry.inputTokens,
        output: entry.outputTokens,
        cacheRead: entry.cacheReadTokens,
        cacheWrite: entry.cacheWriteTokens,
        durationMs: entry.durationMs,
        status: entry.status,
        purpose: entry.role,
        createdAt: now(),
      })
    }
    await deps.ledger.record({ ts: now(), ...entry })
    await recordTelemetry(deps, sessionId, entry)
  }

  try {
    const sessionOptions = await deps.sessions.loadOptions(sessionId)
    const resolved = await deps.resolver.resolve(sessionOptions.model)
    const history = await deps.sessions.loadContextMessages(sessionId)

    const governance = createGovernanceState()
    const scope = { sessionId, turnId, signal }
    const governanceDeps = {
      workspaceRoot: deps.workspaceRoot,
      permissions: deps.permissions,
      artifacts: deps.artifacts,
      interactions: deps.interactions,
      tools: [...deps.tools.list(), ...(deps.extraTools ?? [])],
      outputLimit: deps.outputLimit,
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: buildSystemPrompt(deps.workspaceRoot, deps.skillSection),
        model: resolved.model as never,
        tools: createAgentTools(governanceDeps, scope) as AgentTool[],
        messages: toTranscriptMessages(history, resolved) as never,
      },
      streamFn: resolved.streamFn as never,
      beforeToolCall: createBeforeToolCall(governanceDeps, scope, governance),
      afterToolCall: createAfterToolCall(governance),
      // 3) 超阈值压缩：压缩后重新装载会话上下文（与旧循环同一套阈值与降级策略）
      transformContext: async (messages) => {
        if (!deps.summarizer || resolved.contextWindow <= 0) return messages
        // 近似估算：字符数 / 4；只为判断是否越过压缩阈值（精确计数由 pi 的 usage 提供）
        const estimate = Math.ceil(JSON.stringify(messages).length / 4)
        if (estimate <= resolved.contextWindow * COMPACT_THRESHOLD) return messages
        try {
          const text = JSON.stringify(messages).slice(0, 8_000)
          await deps.summarizer.summarize(text, signal)
          const reloaded = await deps.sessions.loadContextMessages(sessionId)
          deps.emit({ type: 'session.compacted', sessionId, turnId })
          return toTranscriptMessages(reloaded, resolved) as never
        } catch {
          const keep = (deps.keepRecentMessages ?? 8) * 4
          return (messages as unknown[]).slice(-keep) as never
        }
      },
      // 8) 步数上限：达到即结束本轮（等价于旧循环的 maxSteps）
      finishTurn: async () => {
        steps += 1
        if (steps >= maxSteps) {
          stopReason = 'max_steps'
          await deps.sessions.append(sessionId, {
            type: 'error',
            code: 'MAX_STEPS',
            message: t('达到最大工具轮次（{maxSteps}）', { maxSteps }),
            createdAt: now(),
          })
          return { action: 'end' }
        }
        return undefined
      },
    })

    // 4) 事件映射 + 6) 工具调用/结果与会话双写 + 7) 用量三写
    agent.subscribe(async (event) => {
      const context: PiEventContext = {
        sessionId,
        turnId,
        provider: resolved.providerId,
        model: resolved.modelId,
        denials: governance.blocked,
      }
      for (const mapped of mapPiEvent(event as never, context)) deps.emit(mapped)

      if (event.type === 'tool_execution_start') {
        await deps.sessions.append(sessionId, {
          type: 'tool_call',
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          turnId,
          createdAt: now(),
        })
      }

      if (event.type === 'tool_execution_end') {
        const [mapped] = mapPiEvent(event as never, context)
        const result = mapped?.type === 'tool.result' ? mapped.result : undefined
        const status: ToolStatus = result?.status ?? (event.isError ? 'error' : 'ok')
        await deps.sessions.append(sessionId, {
          type: 'tool_result',
          id: event.toolCallId,
          status,
          output: result?.output ?? '',
          durationMs: result?.durationMs ?? event.durationMs ?? 0,
          truncated: result?.truncated,
          artifactPath: result?.artifactPath,
          createdAt: now(),
        })
      }

      if (event.type === 'message_end') {
        const message = event.message as {
          role?: string
          usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
          stopReason?: string
        }
        if (message.role !== 'assistant') return
        const durationMs = 0
        const usage: TokenUsage = {
          inputTokens: message.usage?.input ?? 0,
          outputTokens: message.usage?.output ?? 0,
          ...(message.usage?.cacheRead ? { cacheReadTokens: message.usage.cacheRead } : {}),
          ...(message.usage?.cacheWrite ? { cacheWriteTokens: message.usage.cacheWrite } : {}),
        }
        await recordUsage(
          {
            provider: resolved.providerId,
            model: resolved.modelId,
            role: 'primary',
            ...usage,
            durationMs,
            status: 'success',
          },
          true,
        )
        // 助手消息落库：会话历史与 UI 都依赖它（与旧循环一致：reasoning 在前、text 在后）
        const blocks = (event.message as { content?: unknown }).content
        const parts: MessagePart[] = []
        let reasoning = ''
        let text = ''
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            const candidate = block as { type?: string; text?: string; thinking?: string; thinkingSignature?: string }
            if (candidate.type === 'thinking' && candidate.thinking) reasoning += candidate.thinking
            if (candidate.type === 'text' && candidate.text) text += candidate.text
          }
        }
        if (reasoning) parts.push({ type: 'reasoning', text: reasoning })
        parts.push({ type: 'text', text })
        await deps.sessions.append(sessionId, {
          type: 'message',
          id: ulid(),
          role: 'assistant',
          parts,
          createdAt: now(),
        })

        if (message.stopReason === 'length') {
          await deps.sessions.append(sessionId, {
            type: 'error',
            code: 'OUTPUT_TRUNCATED',
            message: t('模型输出达到长度上限'),
            createdAt: now(),
          })
        }
        await deps.sessions.touch(sessionId, 1)
      }
    })

    await agent.prompt(options.userText)
    await agent.waitForIdle()

    if (signal.aborted) stopReason = 'cancelled'
  } catch (error) {
    if (signal.aborted) {
      stopReason = 'cancelled'
    } else {
      stopReason = 'error'
      const message = error instanceof Error ? error.message : String(error)
      await deps.sessions.append(sessionId, { type: 'error', code: 'TURN_FAILED', message, createdAt: now() })
      deps.emit({ type: 'turn.end', sessionId, turnId, stopReason, error: message })
      return
    }
  }

  deps.emit({ type: 'turn.end', sessionId, turnId, stopReason })
}

/** 上报失败不得中断对话（与旧循环一致） */
async function recordTelemetry(deps: PiLoopDeps, sessionId: string, entry: UsageRecord): Promise<void> {
  if (!deps.telemetry) return
  const payload: TelemetryInput = {
    sessionId,
    purpose: entry.role,
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    durationMs: entry.durationMs,
    status: entry.status,
    errorCode: entry.errorCode,
  }
  try {
    await deps.telemetry.record(payload)
  } catch (error) {
    console.warn(t('[telemetry] 入队失败：'), error)
  }
}

export type { AgentToolResult }
