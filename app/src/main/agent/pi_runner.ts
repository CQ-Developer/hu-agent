/**
 * 回合运行器装配（R3）：把 pi 运行时、原生工具集、治理依赖与事件出口组装成一个函数交给 IPC 层。
 *
 * 目的：IPC 只依赖**一个函数签名**（`runTurn(request)`），不关心 pi 的装配细节；
 * 于是"切换引擎"对上层是一次替换，而不是散落各处的改动。
 *
 * 会话存储与用量账本仍是我们的（R1 才换 `pi-durable`）；密钥从本机密钥库取，
 * 企业模式下由服务端供流（`getSecret` 返回 null 也不会让回合失败，除非确实需要本地密钥）。
 */

import { join } from 'node:path'

import type { AgentEvent } from '../../shared/events'
import { runTurnWithPi, type PiLoopDeps } from './pi_loop'
import { createDefaultTools } from './pi_governance'
import { ulid } from '../session/ulid'
import type { InteractionBroker } from '../permissions/broker'
import type { PermissionEngine } from '../permissions/engine'
import type { ArtifactStore } from '../session/artifacts'
import type { SessionStore } from '../session/store'
import type { UsageLedger } from '../usage/ledger'
import type { TelemetrySink } from '../usage/telemetry'
import { createPiRuntime, type PiRuntime } from '../model/pi_runtime'
import type { NativeTool } from '../tools/native/tool'

export interface PiRunnerOptions {
  workspaceRoot: string
  /** 读本机密钥库（`model:<providerId>`） */
  getSecret: (ref: string) => string | null
  permissions: PermissionEngine
  interactions: InteractionBroker
  sessions: SessionStore
  artifacts: ArtifactStore
  ledger: UsageLedger
  telemetry?: TelemetrySink
  /** agent 目录（models.json 所在；默认 ~/.hu-agent/agent），测试注入 */
  agentDir?: string
  /** 测试注入 pi 的 models 集合（例如 faux provider） */
  models?: Parameters<typeof createPiRuntime>[0]['models']
  skillSection?: string
  /** 压缩用的模型（缺省用当前会话模型） */
  fastTarget?: string
  /** 运行时注入的工具（例如 MCP），与默认工具集合并 */
  extraTools?: NativeTool[]
  maxSteps?: number
  outputLimit?: number
  keepRecentMessages?: number
}

export interface TurnRequest {
  sessionId: string
  userText: string
  signal: AbortSignal
  emit: (event: AgentEvent) => void
  /** 缺省用运行器选项里的工作空间 */
  workspaceRoot?: string
}

export interface PiTurnRunner {
  runTurn(request: TurnRequest): Promise<void>
  /** 设置页保存 models.json 后重新注册 provider */
  refresh(): Promise<void>
  runtime: PiRuntime
}

export function createPiTurnRunner(options: PiRunnerOptions): PiTurnRunner {
  const runtime = createPiRuntime({
    getSecret: options.getSecret,
    ...(options.agentDir ? { path: join(options.agentDir, 'models.json') } : {}),
    ...(options.models ? { models: options.models } : {}),
    ...(options.fastTarget ? { fastTarget: options.fastTarget } : {}),
  })

  return {
    runtime,
    async runTurn(request: TurnRequest): Promise<void> {
      const workspaceRoot = request.workspaceRoot ?? options.workspaceRoot
      const turnId = ulid()
      // 工具按回合构造：ask_guide 需要把提问路由到正确的会话与轮次；MCP 等运行时工具并入
      const tools = [
        ...createDefaultTools({
          workspaceRoot,
          interactions: options.interactions,
          sessionId: request.sessionId,
          turnId,
        }),
        ...(options.extraTools ?? []),
      ]

      const deps: PiLoopDeps = {
        resolver: runtime.resolver,
        tools,
        sessions: options.sessions,
        artifacts: options.artifacts,
        ledger: options.ledger,
        ...(options.telemetry ? { telemetry: options.telemetry } : {}),
        permissions: options.permissions,
        interactions: options.interactions,
        emit: request.emit,
        workspaceRoot,
        ...(options.skillSection ? { skillSection: options.skillSection } : {}),
        ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
        ...(options.outputLimit ? { outputLimit: options.outputLimit } : {}),
        ...(options.keepRecentMessages ? { keepRecentMessages: options.keepRecentMessages } : {}),
        summarizer: runtime.summarizer,
      }

      await runTurnWithPi(deps, {
        sessionId: request.sessionId,
        userText: request.userText,
        signal: request.signal,
        turnId,
      })
    },
    refresh: () => runtime.refresh(),
  }
}
