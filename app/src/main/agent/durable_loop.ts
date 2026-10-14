/**
 * 回合循环（R1）：**回合由 pi-durable 的 harness 跑**，我们只提供工具、治理钩子、事件投影与用量落账。
 *
 * 与上一版（我们自建 `Agent` 循环）的区别：
 * - 不再由我们拼 transcript、跑循环、写会话条目——会话/消息/回合/用量都归 pi-durable；
 * - 我们的治理以**扩展 + 钩子**注入（`beforeTool`/`afterTool`），异步钩子受支持（已实测）；
 * - 界面事件由 `pi.live` 的机械投影产生（`durable_projection.ts`，形状来自实测）；
 * - 运行是异步任务：`submit` 后必须 `wait`，或（界面）订阅 viewState。
 *
 * 保持企业能力不变：权限判定与审批仍在 PermissionEngine；超长输出落 artifact 并中段截断；
 * 用量三写（会话由 pi 落、我们写 ledger 与上报）；被拒绝的调用在 `beforeTool` 被 block，工具体不执行。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { ToolTask, createRegistry, defineExtension, hook, section } from '@earendil-works/pi-durable'

import type { AgentEvent } from '../../shared/events'
import { t } from '../i18n'
import type { InteractionBroker } from '../permissions/broker'
import type { PermissionEngine } from '../permissions/engine'
import type { ArtifactStore } from '../session/artifacts'
import type { DurableSessions } from '../session/durable'
import type { NativeTool } from '../tools/native/tool'
import { truncateMiddle } from '../tools/truncate'
import type { UsageLedger } from '../usage/ledger'
import type { TelemetryInput, TelemetrySink } from '../usage/telemetry'
import { createProjectionState, projectLive, type LiveState, type ProjectionContext } from './durable_projection'
import { buildSystemPrompt } from './prompt'

const DEFAULT_OUTPUT_LIMIT = 32_000

export interface DurableTurnDeps {
  sessions: DurableSessions
  conversationId: string
  /** 会话当前模型（来自会话配置） */
  providerId: string
  modelId: string
  tools: NativeTool[]
  permissions: PermissionEngine
  interactions: InteractionBroker
  artifacts: ArtifactStore
  ledger: UsageLedger
  telemetry?: TelemetrySink
  workspaceRoot: string
  skillSection?: string
  outputLimit?: number
  emit: (event: AgentEvent) => void
}

export interface DurableTurnOptions {
  userText: string
  turnId: string
  signal: AbortSignal
}

interface UsageLike {
  models?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>
  tools?: Record<string, unknown>
}

export async function runDurableTurn(deps: DurableTurnDeps, options: DurableTurnOptions): Promise<void> {
  const { emit, conversationId } = deps
  const base = { sessionId: conversationId, turnId: options.turnId }
  const conversation = await deps.sessions.conversation(conversationId)
  if (!conversation) throw new Error(t('会话不存在：{id}', { id: conversationId }))

  emit({ ...base, type: 'turn.start' })

  // 治理状态：被拒绝的调用（pi 不为被 block 的调用跑 afterTool，故由投影层补状态）
  const denials = new Map<string, { status: 'denied' | 'timeout'; reason?: string }>()

  const Tools = defineExtension({ name: 'huagent.tools', tools: deps.tools as never })
  const Guard = defineExtension({
    name: 'huagent.guard',
    // 系统提示：工作空间 + 已启用 Skill（tag: false，保持我们原有的提示文本形态）
    sections: [section('huagent', () => buildSystemPrompt(deps.workspaceRoot, deps.skillSection), { tag: false })],
    hooks: [
      hook(ToolTask, {
        // 钩子返回形状由 pi-durable 决定（block 为字符串）；异步返回值受支持
        beforeTool: async (call) => {
          const tool = deps.tools.find((candidate) => candidate.name === call.name)
          if (!tool) {
            denials.set(call.id, { status: 'denied', reason: t('未知工具：{name}', { name: call.name }) })
            return { block: t('未知工具：{name}', { name: call.name }) }
          }
          const decision = await deps.permissions.check({
            workspaceRoot: deps.workspaceRoot,
            sessionId: conversationId,
            turnId: options.turnId,
            toolCallId: call.id,
            toolName: tool.name,
            category: tool.category,
            input: (call.arguments ?? {}) as Record<string, unknown>,
          })
          if (decision.action === 'allow') return undefined
          const reason = decision.reason ?? t('权限拒绝')
          denials.set(call.id, { status: 'denied', reason })
          return { block: reason }
        },
        afterTool: async (call, result) => {
          const denial = denials.get(call.id)
          // 被拒绝的调用保持错误语义（模型会据此调整），拒绝原因由投影层补到界面事件上
          if (denial) return { isError: true }
          const blocks = Array.isArray(result?.output) ? (result.output as Array<{ type?: string; text?: string }>) : []
          const text = blocks.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('')
          const limit = deps.outputLimit ?? DEFAULT_OUTPUT_LIMIT
          if (text.length <= limit) return undefined
          const artifactPath = await deps.artifacts.save(call.id, text)
          const { output, truncated } = truncateMiddle(text, limit, artifactPath)
          // ToolExecutionResult 的字段是 output（不是 content）
          return { output: [{ type: 'text', text: output }], details: { truncated, artifactPath } }
        },
      }),
    ],
  })

  const registry = createRegistry()
  registry.install(Tools)
  registry.install(Guard)

  // 会话配置：扩展 + 工具 + cwd（模型沿用会话已配置的值）
  await conversation.configure(
    { extensions: [Tools, Guard], tools: deps.tools as never, modelTools: deps.tools as never, cwd: deps.workspaceRoot },
    BACKGROUND_CONTEXT,
  )

  // 订阅运行期状态：投影成界面事件（增量来自追加式内容块的后缀）
  const projection = createProjectionState()
  const projectionContext: ProjectionContext = {
    sessionId: conversationId,
    turnId: options.turnId,
    provider: deps.providerId,
    model: deps.modelId,
    denials,
  }
  const view = await conversation.viewState(BACKGROUND_CONTEXT)
  const unsubscribe = (view as unknown as { subscribe: (cb: (value: unknown) => void) => () => void }).subscribe(
    (value: unknown) => {
      const docs = (value as { docs?: Record<string, unknown> }).docs ?? {}
      const entries = (value as { entries?: unknown }).entries
      const events = projectLive(
        docs['pi.live'] as LiveState | undefined,
        projection,
        projectionContext,
        Array.isArray(entries) ? (entries as never[]) : [],
      )
      for (const event of events) emit(event)
    },
  )

  // 取消：撤回排队输入并中止本轮（pi-durable 的 abort 语义）
  const onAbort = (): void => {
    void (conversation as unknown as { abort: (context: unknown) => Promise<void> }).abort(BACKGROUND_CONTEXT)
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  let stopReason: 'done' | 'cancelled' | 'error' = 'done'
  let errorMessage: string | undefined

  try {
    const submission = await conversation.submit(
      { type: 'input', content: options.userText, requestId: options.turnId },
      BACKGROUND_CONTEXT,
    )
    const settled = (await submission.wait(BACKGROUND_CONTEXT)) as unknown as { status?: string }
    if (options.signal.aborted) stopReason = 'cancelled'
    else if (settled?.status === 'failed') stopReason = 'error'

    // 用量落账：数据源是 pi 的汇总（含失败与中断）
    const usage = (await deps.sessions.usage()) as UsageLike
    await recordUsage(deps, conversationId, usage, options.turnId, stopReason)
  } catch (error) {
    if (options.signal.aborted) {
      stopReason = 'cancelled'
    } else {
      stopReason = 'error'
      errorMessage = error instanceof Error ? error.message : String(error)
    }
  } finally {
    options.signal.removeEventListener('abort', onAbort)
    unsubscribe()
  }

  emit({ ...base, type: 'turn.end', stopReason, ...(errorMessage ? { error: errorMessage } : {}) })
}

/** 把 pi 的用量汇总写进我们的 ledger 与上报（会话侧的用量由 pi 自己记录） */
async function recordUsage(
  deps: DurableTurnDeps,
  sessionId: string,
  usage: UsageLike,
  turnId: string,
  status: 'done' | 'cancelled' | 'error',
): Promise<void> {
  const models = usage.models ?? {}
  for (const [target, entry] of Object.entries(models)) {
    const [provider, model] = target.includes('/') ? target.split('/') : [deps.providerId, target]
    const inputTokens = entry.input ?? 0
    const outputTokens = entry.output ?? 0
    await deps.ledger.record({
      ts: new Date().toISOString(),
      provider,
      model,
      role: 'primary',
      inputTokens,
      outputTokens,
      ...(entry.cacheRead ? { cacheReadTokens: entry.cacheRead } : {}),
      ...(entry.cacheWrite ? { cacheWriteTokens: entry.cacheWrite } : {}),
      durationMs: 0,
      status: status === 'done' ? 'success' : 'error',
    })
    if (deps.telemetry) {
      const payload: TelemetryInput = {
        sessionId,
        purpose: 'primary',
        provider,
        model,
        inputTokens,
        outputTokens,
        ...(entry.cacheRead ? { cacheReadTokens: entry.cacheRead } : {}),
        ...(entry.cacheWrite ? { cacheWriteTokens: entry.cacheWrite } : {}),
        durationMs: 0,
        status: status === 'done' ? 'success' : 'error',
      }
      void turnId
      try {
        await deps.telemetry.record(payload)
      } catch (error) {
        console.warn(t('[telemetry] 入队失败：'), error)
      }
    }
  }
}
