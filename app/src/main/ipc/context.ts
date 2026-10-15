/**
 * IPC 层的依赖上下文（组合根注入）与工作空间作用域服务。
 *
 * `AppContext` 是 index.ts 组装好的服务集合；`scoped()` 按当前工作空间惰性创建
 * 会话服务与产物存储，`buildEngine()` 组装权限引擎——这三者是各域 IPC 模块的公共依赖。
 */

import { configFilePath, globalDir } from '../config/paths'
import type { ModelSettingsStore } from '../config/pi_model_settings'
import type { SecretStore } from '../config/secrets'
import type { CloudClient } from '../cloud/client'
import type { UsageReporter } from '../cloud/reporter'
import type { DurableTurnRunner } from '../agent/durable_runner'
import { sessionFilesFor } from '../agent/durable_runner'
import { AuditLog } from '../permissions/audit'
import type { InteractionBroker } from '../permissions/broker'
import { PermissionEngine } from '../permissions/engine'
import { ArtifactStore } from '../session/artifacts'
import { DurableSessions } from '../session/durable'
import type { McpManager } from '../mcp/manager'
import type { SkillManager } from '../skills/manager'
import type { MarketClient } from '../market/client'
import type { SkillInstaller } from '../market/installer'
import type { ResourceStatusService } from '../market/status'
import type { SyncScheduler } from '../sync/scheduler'
import type { StatsClient } from '../stats/client'
import type { PiRuntime } from '../model/pi_runtime'
import type { NativeTool } from '../tools/native/tool'
import type { TelemetrySink } from '../usage/telemetry'
import type { UsageLedger } from '../usage/ledger'
import type { WorkspaceManager, WorkspacePaths } from '../workspace'
import { appendWorkspaceRule, loadGlobalRules, loadWorkspaceRules } from '../workspace_settings'

export interface AppContext {
  workspaces: WorkspaceManager
  settings: ModelSettingsStore
  secrets: SecretStore
  /**
   * 每回合构造 runner（R1 切换）：工作空间相关依赖从这里注入，
   * 回合由 pi-durable harness 跑（装配细节见 agent/durable_runner.ts）。
   */
  createRunner: (options: {
    workspaceRoot: string
    permissions: PermissionEngine
    sessions: DurableSessions
    artifacts: ArtifactStore
    telemetry?: TelemetrySink
    skillSection?: string
    extraTools?: NativeTool[]
  }) => DurableTurnRunner
  /** pi 运行时（长生命周期）：会话服务共用它的 models 集合；设置变更后 refresh */
  runtime: PiRuntime
  ledger: UsageLedger
  interactions: InteractionBroker
  skills: SkillManager
  mcp: McpManager
  market: MarketClient
  installer: SkillInstaller
  statuses: ResourceStatusService
  syncScheduler: SyncScheduler
  stats: StatsClient
  cloud: CloudClient
  reporter: UsageReporter
  /** sessionId -> 本会话授权 scope */
  grants: Map<string, Set<string>>
  sessionStores: Map<string, DurableSessions>
  artifactStores: Map<string, ArtifactStore>
  auditLogs: Map<string, AuditLog>
}

export interface Scoped {
  ws: WorkspacePaths
  sessions: DurableSessions
  artifacts: ArtifactStore
}

export async function scoped(context: AppContext): Promise<Scoped> {
  const ws = await context.workspaces.active()
  let sessions = context.sessionStores.get(ws.root)
  if (!sessions) {
    // 每个工作空间一份 SQLite + 一份视图索引（pi-durable 的存储单进程独占）
    const files = sessionFilesFor(globalDir(), ws.id)
    sessions = new DurableSessions({
      ...files,
      models: context.runtime.models,
      cwd: ws.root,
      workspaceId: ws.id,
    })
    await sessions.open()
    context.sessionStores.set(ws.root, sessions)
  }
  let artifacts = context.artifactStores.get(ws.root)
  if (!artifacts) {
    artifacts = new ArtifactStore(ws.artifactDir)
    await artifacts.init()
    context.artifactStores.set(ws.root, artifacts)
  }
  return { ws, sessions, artifacts }
}

export async function buildEngine(context: AppContext, ws: WorkspacePaths): Promise<PermissionEngine> {
  const rules = await loadWorkspaceRules(ws.settingsFile)
  const globalRules = await loadGlobalRules(configFilePath())
  let audit = context.auditLogs.get(ws.root)
  if (!audit) {
    audit = new AuditLog(ws.auditFile)
    context.auditLogs.set(ws.root, audit)
  }
  return new PermissionEngine({
    workspaceRoot: ws.root,
    rules,
    globalRules,
    grants: context.grants,
    broker: context.interactions,
    audit,
    persistRule: (rule) => appendWorkspaceRule(ws.settingsFile, rule),
  })
}
