/**
 * 企业治理：接到 pi 的工具钩子上（ADR-0006 决策 3）。
 *
 * 这里是**纯钩子**，不做工具包装——pi 原生工具本身就是 `AgentTool`，直接交给 `Agent`；
 * 治理只发生在 `beforeToolCall` / `afterToolCall`。这就是"以 pi 为核"的落点：
 * 我们不为 pi 的形状写翻译层，只往它预留的缝隙里挂企业能力。
 *
 * 核心不变式：**换引擎不降低治理强度**。
 * - 权限判定由 `PermissionEngine` 做（含硬规则：敏感路径拒绝、保护文件不可写）；
 *   审批（ask）在引擎内部通过 `InteractionBroker` 等用户决定；
 * - 被拒绝的调用在 `beforeToolCall` 被 block，工具体**不会执行**；
 * - `afterToolCall` 承担两件旧循环的职责（否则换引擎会静默丢掉）：
 *   ① 超长输出落 artifact 并中段截断（避免撑爆上下文）；② 给被 block 的调用补 `details.status`。
 */

import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core'

import { t } from '../i18n'
import type { InteractionBroker } from '../permissions/broker'
import type { PermissionEngine } from '../permissions/engine'
import type { ArtifactStore } from '../session/artifacts'
import { truncateMiddle } from '../tools/truncate'
import { createAskGuideTool } from '../tools/native/ask_guide'
import { createEditFileTool } from '../tools/native/edit_file'
import { createReadFileTool } from '../tools/native/read_file'
import { createBashTool, createPowerShellTool } from '../tools/native/shell'
import type { NativeTool } from '../tools/native/tool'
import { createWriteFileTool } from '../tools/native/write_file'

/** 工具输出上限：超过即落 artifact，返回给模型的内容中段截断 */
const DEFAULT_OUTPUT_LIMIT = 32_000

export interface GovernanceDeps {
  workspaceRoot: string
  permissions: PermissionEngine
  /** 本次回合可用的原生工具（默认工具集 + 运行时注入的 MCP 工具） */
  tools: NativeTool[]
}

export interface ToolScope {
  sessionId: string
  turnId: string
}

/** 跨钩子的共享状态：记录被 block 的调用，供事件映射补状态 */
export interface GovernanceState {
  blocked: Map<string, { status: 'denied' | 'timeout'; reason: string }>
}

export function createGovernanceState(): GovernanceState {
  return { blocked: new Map() }
}

/** 默认工具集：全部 pi 原生；`category` 供权限策略使用 */
export function createDefaultTools(options: {
  workspaceRoot: string
  interactions: InteractionBroker
  sessionId: string
  turnId: string
}): NativeTool[] {
  const { workspaceRoot } = options
  return [
    createReadFileTool({ workspaceRoot }),
    createWriteFileTool({ workspaceRoot }),
    createEditFileTool({ workspaceRoot }),
    createBashTool({ workspaceRoot }),
    createPowerShellTool({ workspaceRoot }),
    createAskGuideTool({
      workspaceRoot,
      interactions: options.interactions,
      sessionId: options.sessionId,
      turnId: options.turnId,
    }),
  ]
}

/** 权限判定：allow 放行；其余一律 block（工具体不执行） */
export function createBeforeToolCall(deps: GovernanceDeps, scope: ToolScope, state: GovernanceState) {
  return async ({ toolCall, args }: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
    const tool = deps.tools.find((candidate) => candidate.name === toolCall.name)
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

export interface AfterToolCallDeps {
  artifacts: ArtifactStore
  outputLimit?: number
}

/**
 * 终局钩子：
 * 1. 被 block 的调用 → 补 `details.status`（UI 才能区分"被拒绝"与"执行报错"）；
 *    注意 pi 不为被 block 的调用执行本钩子，事件映射层另有兜底（实测结论）。
 * 2. 超长输出 → 落 artifact + 中段截断（旧循环的职责，搬到钩子上）。
 */
export function createAfterToolCall(deps: AfterToolCallDeps, state: GovernanceState) {
  return async ({ toolCall, result }: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
    const previous = (result.details ?? {}) as Record<string, unknown>
    const blocked = state.blocked.get(toolCall.id)
    if (blocked) {
      return {
        // 保持 isError=true（模型看到错误会调整策略），UI 依据 status 显示"已拒绝"
        isError: true,
        details: { ...previous, status: blocked.status, reason: blocked.reason },
      }
    }

    const text = (result.content ?? [])
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
    const limit = deps.outputLimit ?? DEFAULT_OUTPUT_LIMIT
    if (text.length <= limit) return undefined

    const artifactPath = await deps.artifacts.save(toolCall.id, text)
    const { output, truncated } = truncateMiddle(text, limit, artifactPath)
    return {
      content: [{ type: 'text', text: output }],
      details: { ...previous, truncated, artifactPath },
    }
  }
}
