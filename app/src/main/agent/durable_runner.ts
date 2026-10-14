/**
 * 回合运行器（R1 最终形态）：会话服务 + durable 回环。**没有任何旧形状的残留**。
 *
 * 与上一版的区别（按"完全用 pi、不为旧代码妥协"的原则）：
 * - 不再有旧会话存储／自研模型解析与压缩／`fastTarget`／`maxSteps`：
 *   会话、消息、回合、压缩、用量全部由 pi-durable 拥有；
 * - 运行器只做三件事：按回合构造原生工具集、把会话配置与工作空间交给回环、把事件投影交给调用方。
 *
 * 会话服务按工作空间实例化（各自一份 SQLite 文件），因为 pi-durable 的存储是单进程独占的。
 */

import { join } from 'node:path'

import type { AgentEvent } from '../../shared/events'
import { t } from '../i18n'
import type { InteractionBroker } from '../permissions/broker'
import type { PermissionEngine } from '../permissions/engine'
import type { ArtifactStore } from '../session/artifacts'
import type { DurableSessions } from '../session/durable'
import type { NativeTool } from '../tools/native/tool'
import { toSessionOptions } from '../session/durable_view'
import type { UsageLedger } from '../usage/ledger'
import type { TelemetrySink } from '../usage/telemetry'
import { createDefaultTools } from './pi_governance'
import { runDurableTurn } from './durable_loop'
import { ulid } from '../session/ulid'

export interface DurableRunnerOptions {
  /** 本工作空间的会话服务（pi-durable，SQLite 单文件） */
  sessions: DurableSessions
  permissions: PermissionEngine
  interactions: InteractionBroker
  artifacts: ArtifactStore
  ledger: UsageLedger
  telemetry?: TelemetrySink
  workspaceRoot: string
  skillSection?: string
  /** 运行时注入的工具（例如 MCP），与默认工具集合并 */
  extraTools?: NativeTool[]
  outputLimit?: number
}

export interface TurnRequest {
  sessionId: string
  userText: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  /** 缺省用运行器选项里的工作空间 */
  workspaceRoot?: string
}

export interface DurableTurnRunner {
  runTurn(request: TurnRequest): Promise<void>
}

export function createDurableTurnRunner(options: DurableRunnerOptions): DurableTurnRunner {
  return {
    async runTurn(request: TurnRequest): Promise<void> {
      const workspaceRoot = request.workspaceRoot ?? options.workspaceRoot
      const turnId = ulid()

      // 会话配置（模型）由 pi 保存：投影需要 provider/model 标签
      const agent = await options.sessions.agentConfig(request.sessionId)
      const target = toSessionOptions(agent).model
      const slash = target.indexOf('/')
      if (slash <= 0) {
        throw new Error(t('未配置模型：请在设置中填写 provider 的 baseUrl、模型与密钥'))
      }

      // 工具按回合构造（ask_guide 需要把提问路由到正确的会话与轮次；MCP 等运行时工具并入）
      const tools = [
        ...createDefaultTools({
          workspaceRoot,
          interactions: options.interactions,
          sessionId: request.sessionId,
          turnId,
        }),
        ...(options.extraTools ?? []),
      ]

      await runDurableTurn(
        {
          sessions: options.sessions,
          conversationId: request.sessionId,
          providerId: target.slice(0, slash),
          modelId: target.slice(slash + 1),
          tools,
          permissions: options.permissions,
          interactions: options.interactions,
          artifacts: options.artifacts,
          ledger: options.ledger,
          ...(options.telemetry ? { telemetry: options.telemetry } : {}),
          workspaceRoot,
          ...(options.skillSection ? { skillSection: options.skillSection } : {}),
          ...(options.outputLimit ? { outputLimit: options.outputLimit } : {}),
          emit: request.emit,
        },
        { userText: request.userText, turnId, signal: request.signal },
      )
    },
  }
}

/** 工作空间的会话文件路径（每个工作空间一份 SQLite + 一份视图索引） */
export function sessionFilesFor(globalDir: string, workspaceId: string): { file: string; indexFile: string } {
  return {
    file: join(globalDir, 'sessions', `${workspaceId}.sqlite`),
    indexFile: join(globalDir, 'sessions', `${workspaceId}.index.json`),
  }
}
