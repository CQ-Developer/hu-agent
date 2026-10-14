/**
 * 企业治理适配：把我们的权限/审批/审计接到 pi 的工具钩子上（ADR-0006 决策 3）。
 *
 * 核心不变式：**换引擎不降低治理强度**。
 * - 权限判定仍由 `PermissionEngine` 做（含硬规则：敏感路径拒绝、保护文件不可写），
 *   审批（ask）也在引擎内部通过 `InteractionBroker` 等用户决定——适配层只负责把结论交给 pi；
 * - 被拒绝的调用在 `beforeToolCall` 被 block，工具体**不会执行**；
 * - 被拒绝的结果在 `afterToolCall` 打上 `details.status = 'denied'`，UI 才能区分
 *   "用户/策略拒绝" 与 "工具执行报错"（pi 的 block 结果本身不带 details，需要在终局钩子里补）。
 */

import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

import { t } from '../i18n'
import type { InteractionBroker } from '../permissions/broker'
import type { PermissionEngine } from '../permissions/engine'
import type { ArtifactStore } from '../session/artifacts'
import type { ToolStatus } from '../session/types'
import { ToolInputError } from '../tools/path-guard'
import { truncateMiddle } from '../tools/truncate'
import type { AnyTool, ToolContext } from '../tools/types'

const OUTPUT_LIMIT = 32_000

export interface GovernanceDeps {
  workspaceRoot: string
  permissions: PermissionEngine
  artifacts: ArtifactStore
  interactions: InteractionBroker
  /** 本回合可用工具（含 MCP 等运行时工具） */
  tools: AnyTool[]
  outputLimit?: number
}

export interface ToolScope {
  sessionId: string
  turnId: string
  signal: AbortSignal
}

/** 跨钩子的共享状态：记录被 block 的调用，供终局钩子补状态标记 */
export interface GovernanceState {
  blocked: Map<string, { status: Extract<ToolStatus, 'denied' | 'timeout'>; reason: string }>
}

export function createGovernanceState(): GovernanceState {
  return { blocked: new Map() }
}

function findTool(deps: GovernanceDeps, name: string): AnyTool | undefined {
  return deps.tools.find((tool) => tool.name === name)
}

/** 权限判定入口：allow 放行；其余一律 block（工具体不执行） */
export function createBeforeToolCall(deps: GovernanceDeps, scope: ToolScope, state: GovernanceState) {
  return async ({ toolCall, args }: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const tool = findTool(deps, toolCall.name)
    if (!tool) {
      const reason = t('未知工具：{name}', { name: toolCall.name })
      state.blocked.set(toolCall.id, { status: 'denied', reason })
      return { block: true, reason }
    }

    const decision = await deps.permissions.check({
      workspaceRoot: deps.workspaceRoot,
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      toolCallId: toolCall.id,
      toolName: tool.name,
      category: tool.category,
      input: (args ?? {}) as Record<string, unknown>,
    })
    if (decision.action === 'allow') return undefined

    const reason = decision.reason ?? t('权限拒绝')
    state.blocked.set(toolCall.id, { status: 'denied', reason })
    return { block: true, reason }
  }
}

/** 终局钩子：给被 block 的调用补 status，其余保持原样 */
export function createAfterToolCall(state: GovernanceState) {
  return async ({ toolCall, result }: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    const blocked = state.blocked.get(toolCall.id)
    if (!blocked) return undefined
    const previous = (result.details ?? {}) as Record<string, unknown>
    return {
      // 保持 isError=true（模型看到错误会调整策略），但 UI 依据 status 显示"已拒绝"
      isError: true,
      details: { ...previous, status: blocked.status, reason: blocked.reason },
    }
  }
}

/** 把授权工具改造成 pi 的 AgentTool；执行语义与我们此前的循环保持一致（截断、产物、错误分类） */
export function createAgentTools(deps: GovernanceDeps, scope: ToolScope): AgentTool[] {
  return deps.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // 我们的工具栏用 JSON Schema 描述参数，这里原样交给 pi（typebox 的 Unsafe 包装）
    parameters: Type.Unsafe(tool.parameters as never),
    execute: async (toolCallId: string, params: unknown) => {
      const startedAt = Date.now()
      const context: ToolContext = {
        workspaceRoot: deps.workspaceRoot,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        signal: scope.signal,
        artifacts: deps.artifacts,
        interactions: deps.interactions,
      }

      let status: ToolStatus = 'ok'
      let rawOutput: string
      try {
        const result = await tool.run(params ?? {}, context)
        status = result.status
        rawOutput = result.output
      } catch (error) {
        if (error instanceof ToolInputError) {
          status = 'error'
          rawOutput = error.message
        } else if (scope.signal.aborted) {
          status = 'timeout'
          rawOutput = t('工具执行已取消')
        } else {
          status = 'error'
          rawOutput = t('工具执行失败：{0}', { 0: error instanceof Error ? error.message : String(error) })
        }
      }

      const limit = deps.outputLimit ?? OUTPUT_LIMIT
      const artifactPath = rawOutput.length > limit ? await deps.artifacts.save(toolCallId, rawOutput) : undefined
      const { output, truncated } = truncateMiddle(rawOutput, limit, artifactPath)
      const details = {
        status,
        durationMs: Date.now() - startedAt,
        ...(truncated ? { truncated: true } : {}),
        ...(artifactPath ? { artifactPath } : {}),
      }

      if (status !== 'ok') throw Object.assign(new Error(output), { name: 'ToolExecutionError', details })
      return { content: [{ type: 'text' as const, text: output }], details }
    },
  }))
}

export type { AgentTool }
