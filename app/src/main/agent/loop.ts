/** Agent Loop（design 5.2.2）：模型流式 -> 工具调用 -> 结果回填 -> 循环，直到无工具调用。 */

import { ModelError } from '../model/errors'
import type { ModelGateway } from '../model/gateway'
import type { LlmMessage, StopReason, TokenUsage, ToolCall } from '../model/types'
import type { ArtifactStore } from '../session/artifacts'
import type { SessionStore } from '../session/store'
import { ulid } from '../session/ulid'
import type { MessagePart, ToolStatus } from '../session/types'
import type { UsageLedger } from '../usage/ledger'
import type { InteractionBroker } from '../permissions/broker'
import type { PermissionEngine } from '../permissions/engine'
import { OUTPUT_LIMIT, truncateMiddle } from '../tools/truncate'
import { ToolInputError } from '../tools/path-guard'
import type { ToolRegistry } from '../tools/registry'
import { toModelTool, type AnyTool, type ToolContext } from '../tools/types'
import type { AgentEvent, TurnStopReason } from '../../shared/events'
import { COMPACT_THRESHOLD, compactHistory, estimateTokens } from './compaction'
import { buildSystemPrompt } from './prompt'

export interface LoopDeps {
  gateway: ModelGateway
  tools: ToolRegistry
  /** 动态工具（如 MCP），每轮随工作空间连接状态注入 */
  extraTools?: AnyTool[]
  sessions: SessionStore
  artifacts: ArtifactStore
  ledger: UsageLedger
  permissions: PermissionEngine
  interactions: InteractionBroker
  emit: (event: AgentEvent) => void
  workspaceRoot: string
  /** 已启用 Skill 的元数据（design 5.7.3，注入系统提示） */
  skillSection?: string
  /** 历史压缩使用的快速模型（缺省用当前会话模型） */
  fastTarget?: string
  keepRecentMessages?: number
  maxSteps?: number
  outputLimit?: number
}

export interface TurnOptions {
  sessionId: string
  userText: string
  signal: AbortSignal
}

interface ToolExecution {
  status: ToolStatus
  output: string
  durationMs: number
  truncated: boolean
  artifactPath?: string
}

export async function runTurn(deps: LoopDeps, options: TurnOptions): Promise<void> {
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
  try {
    let messages = await deps.sessions.loadContextMessages(sessionId)
    const sessionOptions = await deps.sessions.loadOptions(sessionId)
    const { provider, model } = deps.gateway.resolve(sessionOptions.model)

    for (let step = 0; step < maxSteps; step += 1) {
      let modelMessages: LlmMessage[] = [
        { role: 'system', content: buildSystemPrompt(deps.workspaceRoot, deps.skillSection) },
        ...messages,
      ]

      // 超过上下文阈值：压缩历史（失败则降级为保留最近消息）
      const contextWindow = model.capabilities.contextWindow
      if (contextWindow > 0 && estimateTokens(modelMessages) > contextWindow * COMPACT_THRESHOLD) {
        const compacted = await compactHistory(
          {
            gateway: deps.gateway,
            sessions: deps.sessions,
            ledger: deps.ledger,
            fastTarget: deps.fastTarget ?? sessionOptions.model ?? model.name,
            keepRecentMessages: deps.keepRecentMessages,
          },
          sessionId,
          signal,
        ).catch(() => false)
        messages = compacted
          ? await deps.sessions.loadContextMessages(sessionId)
          : messages.slice(-(deps.keepRecentMessages ?? 8) * 4)
        modelMessages = [{ role: 'system', content: buildSystemPrompt(deps.workspaceRoot, deps.skillSection) }, ...messages]
        deps.emit({ type: 'session.compacted', sessionId, turnId })
      }

      let assistantText = ''
      let reasoningText = ''
      let reasoningSignature = ''
      const toolCalls: ToolCall[] = []
      let usage: TokenUsage | undefined
      let modelStop: StopReason = 'stop'
      const startedAt = Date.now()

      try {
        for await (const event of deps.gateway.chat(
          { target: sessionOptions.model, reasoningEffort: sessionOptions.reasoningEffort },
          modelMessages,
          deps.tools.toModelTools().concat((deps.extraTools ?? []).map(toModelTool)),
          signal,
        )) {
          if (event.type === 'text_delta') {
            assistantText += event.text
            deps.emit({ type: 'assistant.delta', sessionId, turnId, text: event.text })
          } else if (event.type === 'reasoning_delta') {
            if (event.text) reasoningText += event.text
            if (event.signatureDelta) reasoningSignature += event.signatureDelta
            deps.emit({ type: 'reasoning.delta', sessionId, turnId, text: event.text })
          } else if (event.type === 'tool_call') {
            toolCalls.push(event.call)
          } else if (event.type === 'usage') {
            usage = event.usage
            deps.emit({
              type: 'usage.update',
              sessionId,
              turnId,
              usage: event.usage,
              provider: provider.id,
              model: model.name,
            })
          } else if (event.type === 'done') {
            modelStop = event.stopReason
          }
        }
      } catch (error) {
        const durationMs = Date.now() - startedAt
        const kind = error instanceof ModelError ? error.kind : 'unknown'
        await deps.ledger.record({
          ts: now(),
          provider: provider.id,
          model: model.name,
          role: 'primary',
          inputTokens: 0,
          outputTokens: 0,
          durationMs,
          status: 'error',
          errorCode: kind,
        })
        throw error
      }

      const durationMs = Date.now() - startedAt
      await deps.sessions.append(sessionId, {
        type: 'usage',
        provider: provider.id,
        model: model.name,
        input: usage?.inputTokens ?? 0,
        output: usage?.outputTokens ?? 0,
        cacheRead: usage?.cacheReadTokens,
        cacheWrite: usage?.cacheWriteTokens,
        durationMs,
        status: 'success',
        purpose: 'primary',
        createdAt: now(),
      })
      await deps.ledger.record({
        ts: now(),
        provider: provider.id,
        model: model.name,
        role: 'primary',
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens,
        cacheWriteTokens: usage?.cacheWriteTokens,
        durationMs,
        status: 'success',
      })

      messages.push({
        role: 'assistant',
        content: assistantText,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        reasoning: reasoningText
          ? { text: reasoningText, signature: reasoningSignature || undefined }
          : undefined,
      })
      const parts: MessagePart[] = []
      if (reasoningText) {
        parts.push({ type: 'reasoning', text: reasoningText, signature: reasoningSignature || undefined })
      }
      parts.push({ type: 'text', text: assistantText })
      await deps.sessions.append(sessionId, {
        type: 'message',
        id: ulid(),
        role: 'assistant',
        parts,
        createdAt: now(),
      })
      await deps.sessions.touch(sessionId, 1)

      if (toolCalls.length === 0) {
        if (modelStop === 'length') {
          await deps.sessions.append(sessionId, {
            type: 'error',
            code: 'OUTPUT_TRUNCATED',
            message: '模型输出达到长度上限',
            createdAt: now(),
          })
        }
        break
      }

      for (const call of toolCalls) {
        await deps.sessions.append(sessionId, {
          type: 'tool_call',
          id: call.id,
          name: call.name,
          args: call.input,
          turnId,
          createdAt: now(),
        })
        deps.emit({ type: 'tool.call', sessionId, turnId, call })

        const execution = await executeTool(deps, call, { sessionId, turnId, signal })
        await deps.sessions.append(sessionId, {
          type: 'tool_result',
          id: call.id,
          status: execution.status,
          output: execution.output,
          durationMs: execution.durationMs,
          truncated: execution.truncated,
          artifactPath: execution.artifactPath,
          createdAt: now(),
        })
        deps.emit({
          type: 'tool.result',
          sessionId,
          turnId,
          result: {
            id: call.id,
            name: call.name,
            status: execution.status,
            output: execution.output,
            durationMs: execution.durationMs,
            truncated: execution.truncated,
            artifactPath: execution.artifactPath,
          },
        })
        messages.push({ role: 'tool', toolCallId: call.id, content: execution.output })
      }

      if (step === maxSteps - 1) {
        stopReason = 'max_steps'
        await deps.sessions.append(sessionId, {
          type: 'error',
          code: 'MAX_STEPS',
          message: `达到最大工具轮次（${maxSteps}）`,
          createdAt: now(),
        })
      }
    }
  } catch (error) {
    if (signal.aborted) {
      stopReason = 'cancelled'
    } else {
      stopReason = 'error'
      const message = error instanceof ModelError ? `${error.kind}: ${error.message}` : String(error)
      await deps.sessions.append(sessionId, { type: 'error', code: 'TURN_FAILED', message, createdAt: now() })
      deps.emit({ type: 'turn.end', sessionId, turnId, stopReason, error: message })
      return
    }
  }

  deps.emit({ type: 'turn.end', sessionId, turnId, stopReason })
}

async function executeTool(
  deps: LoopDeps,
  call: ToolCall,
  scope: { sessionId: string; turnId: string; signal: AbortSignal },
): Promise<ToolExecution> {
  const startedAt = Date.now()
  const tool = deps.tools.get(call.name) ?? deps.extraTools?.find((item) => item.name === call.name)
  if (!tool) {
    return { status: 'error', output: `未知工具：${call.name}`, durationMs: 0, truncated: false }
  }

  const context: ToolContext = {
    workspaceRoot: deps.workspaceRoot,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    signal: scope.signal,
    artifacts: deps.artifacts,
    interactions: deps.interactions,
  }

  // 所有工具调用先过权限引擎（design 5.5）
  const permission = await deps.permissions.check({
    workspaceRoot: deps.workspaceRoot,
    sessionId: scope.sessionId,
    turnId: scope.turnId,
    toolCallId: call.id,
    toolName: call.name,
    category: tool.category,
    input: (call.input ?? {}) as Record<string, unknown>,
  })
  if (permission.action !== 'allow') {
    return {
      status: 'denied',
      output: permission.reason ?? '权限拒绝',
      durationMs: Date.now() - startedAt,
      truncated: false,
    }
  }

  let status: ToolStatus = 'ok'
  let rawOutput: string
  try {
    const result = await tool.run((call.input ?? {}) as Record<string, unknown>, context)
    status = result.status
    rawOutput = result.output
  } catch (error) {
    if (error instanceof ToolInputError) {
      status = 'error'
      rawOutput = error.message
    } else if (scope.signal.aborted) {
      status = 'timeout'
      rawOutput = '工具执行已取消'
    } else {
      status = 'error'
      rawOutput = `工具执行失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const limit = deps.outputLimit ?? OUTPUT_LIMIT
  const artifactPath = rawOutput.length > limit ? await deps.artifacts.save(call.id, rawOutput) : undefined
  const { output, truncated } = truncateMiddle(rawOutput, limit, artifactPath)

  return { status, output, durationMs: Date.now() - startedAt, truncated, artifactPath }
}
