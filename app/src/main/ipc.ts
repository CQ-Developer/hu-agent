/** 主进程 IPC 注册（design 5.1/5.5/5.6）。 */

import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { PiTurnRunner } from './agent/pi_runner'
import type { ModelSettings, ReasoningEffort } from './model/types'

import type { SecretStore } from './config/secrets'

import { configFilePath } from './config/paths'
import type { CloudClient } from './cloud/client'
import type { UsageReporter } from './cloud/reporter'
import { AuditLog, readAuditTail } from './permissions/audit'
import type { InteractionBroker } from './permissions/broker'
import { PermissionEngine } from './permissions/engine'
import type { ApprovalChoice } from './permissions/types'
import { ArtifactStore } from './session/artifacts'
import { buildSessionItems } from './session/items'
import { SessionStore } from './session/store'
import { computeSessionUsage } from './session/stats'
import { globalMcpFile, loadMcpFile, materializeSecrets, saveMcpServer, workspaceMcpFile, type McpServerConfig } from './mcp/config'
import type { McpManager } from './mcp/manager'
import type { SkillManager } from './skills/manager'
import { compareSemver } from './skills/parser'
import { MarketClient } from './market/client'
import type { InstalledSkill, SkillInstaller } from './market/installer'
import { isHardDisabled, type ResourceStatusService, type StatusCache } from './market/status'
import { reportActivationSnapshot } from './market/activations'
import { SyncEngine } from './sync/engine'
import { CloudSyncBackend } from './sync/backend'
import { SyncScheduler, loadSyncSettings, saveSyncSettings, type SyncSchedule } from './sync/scheduler'
import { SsoLoginFlow } from './cloud/sso'
import { exportDiagnostics } from './diagnostics'
import { StatsClient } from './stats/client'
import type { LocaleView } from '../shared/ipc'
import type { LocalePreference } from '../shared/i18n'
import type { SyncStatusView } from '../shared/ipc'
import type { SessionOptionsView } from '../shared/ipc'
import type { SkillView } from '../shared/ipc'
import type { MarketSkill } from './market/client'
import type { AgentEvent, ApprovalRequestView, GuideRequestView } from '../shared/events'
import { bridgeLegacyTools } from './tools/mcp_bridge'
import type { NativeTool } from './tools/native/tool'
import type { ModelSettingsStore } from './config/pi_model_settings'
import type { TelemetrySink } from './usage/telemetry'
import type { UsageLedger } from './usage/ledger'
import type { WorkspaceManager, WorkspacePaths } from './workspace'
import { appendWorkspaceRule, loadGlobalRules, loadWorkspaceRules } from './workspace-settings'
import { getLocale, getLocalePreference, setLocale, systemLocale, t } from './i18n'

export interface AppContext {
  workspaces: WorkspaceManager
  settings: ModelSettingsStore
  secrets: SecretStore
  /**
   * 每回合构造 runner（R3 切换）：工作空间相关依赖从这里注入，
   * 引擎装配（models.json → pi-ai → Agent → 原生工具 + 治理钩子）在 runner 内部完成。
   */
  createRunner: (options: {
    workspaceRoot: string
    permissions: PermissionEngine
    sessions: SessionStore
    artifacts: ArtifactStore
    telemetry?: TelemetrySink
    skillSection?: string
    fastTarget?: string
    extraTools?: NativeTool[]
  }) => PiTurnRunner
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
  sessionStores: Map<string, SessionStore>
  artifactStores: Map<string, ArtifactStore>
  auditLogs: Map<string, AuditLog>
}

export function broadcastEvent(event: AgentEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('agent:event', event)
  }
}

/** 定时同步结果推送给渲染进程（design 5.11.5）。 */
export function broadcastSyncEvent(view: SyncStatusView): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sync:event', view)
  }
}

/** 会话被服务端拒绝（ADR 0004）：通知所有窗口退回登录门禁。 */
export function broadcastSessionLost(reason: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('cloud:session-lost', reason)
  }
}

/** 把交互桥的请求包装成统一的 AgentEvent 通道。 */
export function broadcastInteraction(view: ApprovalRequestView | GuideRequestView): void {
  if ('toolName' in view) {
    broadcastEvent({
      type: 'tool.approval_required',
      sessionId: view.sessionId,
      turnId: view.turnId,
      request: view,
    })
  } else {
    broadcastEvent({ type: 'ask_guide', sessionId: view.sessionId, turnId: view.turnId, request: view })
  }
}

interface Scoped {
  ws: WorkspacePaths
  sessions: SessionStore
  artifacts: ArtifactStore
}

async function scoped(context: AppContext): Promise<Scoped> {
  const ws = await context.workspaces.active()
  let sessions = context.sessionStores.get(ws.root)
  if (!sessions) {
    sessions = new SessionStore(ws.sessionDir)
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

async function buildEngine(context: AppContext, ws: WorkspacePaths): Promise<PermissionEngine> {
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

export function registerIpc(context: AppContext): void {
  const activeTurns = new Map<string, AbortController>()

  ipcMain.handle('app:get-version', () => app.getVersion())

  // ---------- 设置 ----------
  ipcMain.handle('settings:get', () => buildSettingsView(context))
  ipcMain.handle('settings:get-locale', () => localeView())
  ipcMain.handle('cloud:update-locale', async (_event, locale: 'zh-CN' | 'en-US') => {
    // 未登录/离线时静默失败：本地语言已切换（users.locale 仅影响通知与邮件）
    await context.cloud.updateLocale(locale).catch(() => undefined)
  })
  ipcMain.handle('settings:set-locale', async (_event, preference: LocalePreference) => {
    const resolved = await setLocale(preference)
    console.log(t('语言已切换为 {0}', { 0: resolved }))
    return localeView()
  })
  ipcMain.handle('settings:save-provider', async (_event, input: SaveProviderInputWire) => {
    const settings = await context.settings.load()
    const secretKey = input.apiKeyRef ?? `provider.${input.id}`
    if (typeof input.apiKey === 'string') {
      if (input.apiKey.length === 0) await context.secrets.delete(secretKey)
      else await context.secrets.set(secretKey, input.apiKey)
    }
    const providers = settings.providers.filter((provider) => provider.id !== input.id)
    providers.push({
      id: input.id,
      apiType: input.apiType,
      baseUrl: input.baseUrl,
      apiKeyRef: context.secrets.has(secretKey) ? secretKey : null,
      models: input.models,
    })
    const defaults = { ...settings.defaults }
    if (!providers.some((provider) => provider.id === defaults.primary.split('/')[0])) {
      defaults.primary = `${providers[0]?.id ?? ''}/${providers[0]?.models[0]?.name ?? ''}`
    }
    await context.settings.save({ providers, defaults })
    return buildSettingsView(context)
  })
  ipcMain.handle('settings:remove-provider', async (_event, providerId: string) => {
    const settings = await context.settings.load()
    const providers = settings.providers.filter((provider) => provider.id !== providerId)
    await context.settings.save({ ...settings, providers })
    return buildSettingsView(context)
  })
  ipcMain.handle('settings:set-default', async (_event, role: 'primary' | 'fast', target: string) => {
    const settings = await context.settings.load()
    const next: ModelSettings = { ...settings, defaults: { ...settings.defaults, [role]: target } }
    await context.settings.save(next)
    return buildSettingsView(context)
  })

  // ---------- 会话 ----------
  ipcMain.handle('sessions:list', async () => (await scoped(context)).sessions.list())
  ipcMain.handle('sessions:create', async () => (await scoped(context)).sessions.create())
  ipcMain.handle('sessions:items', async (_event, sessionId: string) => {
    const { sessions } = await scoped(context)
    return buildSessionItems((await sessions.readLines(sessionId)).lines)
  })
  ipcMain.handle('sessions:rename', async (_event, sessionId: string, title: string) => {
    const { sessions } = await scoped(context)
    return sessions.rename(sessionId, title)
  })
  ipcMain.handle('sessions:options', async (_event, sessionId: string) =>
    resolveSessionOptions(context, sessionId),
  )
  ipcMain.handle('sessions:set-options', async (_event, sessionId: string, options: SessionOptionsView) => {
    const { sessions } = await scoped(context)
    await sessions.setOptions(sessionId, { model: options.model, reasoningEffort: options.reasoningEffort })
    return resolveSessionOptions(context, sessionId)
  })
  ipcMain.handle('sessions:stats', async (_event, sessionId: string) => {
    const { sessions } = await scoped(context)
    const lines = (await sessions.readLines(sessionId)).lines
    const options = await resolveSessionOptions(context, sessionId)
    const settings = await context.settings.load()
    return computeSessionUsage(lines, contextWindowOf(settings, options.model))
  })
  ipcMain.handle('sessions:search', async (_event, query: string) => (await scoped(context)).sessions.search(query))

  // ---------- Agent ----------
  ipcMain.handle('agent:send', async (_event, sessionId: string, text: string) => {
    if (activeTurns.has(sessionId)) throw new Error(t('该会话已有运行中的任务'))
    const { ws, sessions, artifacts } = await scoped(context)
    const permissions = await buildEngine(context, ws)
    const settings = await context.settings.load()
    const controller = new AbortController()
    activeTurns.set(sessionId, controller)
    try {
      const runner = context.createRunner({
        workspaceRoot: ws.root,
        permissions,
        sessions,
        artifacts,
        fastTarget: settings.defaults.fast ?? settings.defaults.primary,
        skillSection: await context.skills.systemPromptSection(ws),
        // MCP 仍是自研客户端（R4 换 pi-mcp），此处用过渡桥把旧工具接成原生工具
        extraTools: bridgeLegacyTools(await context.mcp.tools(ws), {
          workspaceRoot: ws.root,
          sessionId,
          turnId: '',
          artifacts,
          interactions: context.interactions,
        }),
        telemetry: {
          record: async (input) => {
            try {
              await context.reporter.enqueue(ws, input)
              // 入队后后台尝试上报（未到退避时间会自动跳过）
              void context.reporter.tick([ws])
            } catch (error) {
              console.warn(t('[telemetry] 入队失败：'), error)
            }
          },
        },
      })

      await runner.runTurn(
        { sessionId, userText: text, signal: controller.signal, emit: broadcastEvent },
      )
    } finally {
      activeTurns.delete(sessionId)
    }
  })
  ipcMain.handle('agent:cancel', (_event, sessionId: string) => {
    activeTurns.get(sessionId)?.abort()
    context.interactions.cancelSession(sessionId)
  })
  ipcMain.handle('agent:decide-approval', (_event, requestId: string, choice: ApprovalChoice) => {
    context.interactions.resolveApproval(requestId, choice)
  })
  ipcMain.handle('agent:answer-guide', (_event, requestId: string, value: string) => {
    context.interactions.answerGuide(requestId, value)
  })

  // ---------- 工作空间 ----------
  ipcMain.handle('workspace:list', async () =>
    (await context.workspaces.list()).map((ws) => ({ id: ws.id, name: ws.name, root: ws.root })),
  )
  ipcMain.handle('workspace:active', async () => {
    const ws = await context.workspaces.active()
    return { id: ws.id, name: ws.name, root: ws.root }
  })
  ipcMain.handle('workspace:set-active', async (_event, id: string) => {
    const ws = await context.workspaces.setActive(id)
    // 切换后后台预热 MCP（失败不影响会话，状态在 MCP 页面可见）
    void context.mcp.tools(ws).catch(() => undefined)
    // 重新武装定时同步（每个工作空间有独立档位）
    context.syncScheduler.configure((await loadSyncSettings(ws)).schedule)
    return { id: ws.id, name: ws.name, root: ws.root }
  })
  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: t('选择工作空间目录'),
      properties: ['openDirectory', 'createDirectory'],
    })
    const picked = result.filePaths[0]
    if (result.canceled || !picked) return null
    const ws = await context.workspaces.add(picked)
    return { id: ws.id, name: ws.name, root: ws.root }
  })

  // ---------- 其他 ----------
  ipcMain.handle('usage:stats', () => context.ledger.stats())

  // ---------- Skill ----------
  ipcMain.handle('skills:list', async () => {
    const { ws } = await scoped(context)
    return buildSkillViews(context, ws)
  })
  ipcMain.handle(
    'skills:set-enabled',
    async (_event, name: string, scope: 'global' | 'workspace', enabled: boolean) => {
      const { ws } = await scoped(context)
      if (enabled) await context.skills.setEnabled(ws, name, scope)
      else await context.skills.setDisabled(ws, name, scope)
      await reportScope(context, ws, scope)
      return buildSkillViews(context, ws)
    },
  )

  // ---------- 市场（design 5.7.4 / 5.12） ----------
  ipcMain.handle('market:list', async (_event, params?: Record<string, string>) => {
    const [result, installed, cache] = await Promise.all([
      context.market.listSkills({
        q: params?.q,
        tag: params?.tag,
        sort: params?.sort as 'updated' | 'name' | 'downloads' | undefined,
      }),
      context.installer.list(),
      context.statuses.load(),
    ])
    return result.items.map((item) => toMarketView(item, installed, cache))
  })
  ipcMain.handle('market:detail', async (_event, skillId: string) => {
    const [detail, installed, cache] = await Promise.all([
      context.market.skillDetail(skillId),
      context.installer.list(),
      context.statuses.load(),
    ])
    const view = toMarketView(detail, installed, cache)
    const front = detail.manifest?.frontMatter ?? {}
    return {
      ...view,
      disabledReason: detail.disabledReason ?? null,
      skillMd: detail.skillMd ?? '',
      scripts: detail.manifest?.scripts ?? [],
      requires: {
        tools: front.requires?.tools ?? [],
        bins: front.requires?.bins ?? [],
        network: front.requires?.network ?? false,
      },
      versions: detail.versions.map((version) => ({
        version: version.version,
        status: version.status,
        digest: version.digest,
        sizeBytes: version.sizeBytes,
        fileCount: version.fileCount,
        changelog: version.changelog,
        createdAt: version.createdAt,
      })),
    }
  })
  ipcMain.handle('market:install', async (_event, skillId: string, version: string) => {
    const { ws } = await scoped(context)
    const result = await context.installer.install(skillId, version)
    await context.statuses.check({ force: true })
    await reportScope(context, ws, 'global')
    return { name: result.skill.name, version: result.skill.version, files: result.files }
  })
  ipcMain.handle('market:uninstall', async (_event, skillId: string) => {
    const { ws } = await scoped(context)
    const installed = (await context.installer.list()).filter((item) => item.skillId === skillId)
    for (const item of installed) {
      // 先从启用列表移除（design 5.7.4：卸载 = 从启用列表移除 + 删除目录）
      for (const scope of ['global', 'workspace'] as const) {
        try {
          await context.skills.setDisabled(ws, item.name, scope)
        } catch {
          // 未启用或不存在：忽略
        }
      }
    }
    const removed = await context.installer.uninstall(skillId)
    await reportScope(context, ws, 'global')
    return removed
  })
  ipcMain.handle('market:installed', async () => {
    const [installed, cache] = await Promise.all([context.installer.list(), context.statuses.load()])
    return installed.map((item) => {
      const entry = cache.skills[item.skillId]
      return {
        skillId: item.skillId,
        name: item.name,
        version: item.version,
        digest: item.digest,
        installedAt: item.installedAt,
        state: entry?.status,
        stateReason: entry?.reason,
        replacementVersion: entry?.replacementVersion,
      }
    })
  })
  ipcMain.handle('market:check-status', async (_event, force?: boolean) => {
    return context.statuses.check({ force: force ?? true })
  })

  // ---------- 云同步（design 5.11 / 6.6） ----------
  const syncEngine = async (): Promise<SyncEngine> => {
    const { ws } = await scoped(context)
    return new SyncEngine(new CloudSyncBackend(context.cloud), ws)
  }
  ipcMain.handle('sync:status', async () => (await syncEngine()).status())
  ipcMain.handle('sync:now', async () => (await syncEngine()).syncNow())
  ipcMain.handle('sync:versions', async () => (await syncEngine()).versions())
  ipcMain.handle('sync:restore', async (_event, version: number) =>
    (await syncEngine()).restore(version, { keepLocalCopy: true }),
  )
  ipcMain.handle(
    'sync:resolve',
    async (_event, choice: 'keep-local' | 'cancel' | 'export-diff') => {
      const view = await (await syncEngine()).resolve(choice)
      // 冲突解除后重新武装定时同步（design 5.11.5）
      if (view.status !== 'conflict') {
        const { ws } = await scoped(context)
        context.syncScheduler.configure((await loadSyncSettings(ws)).schedule)
      }
      return view
    },
  )
  ipcMain.handle('sync:pin', async (_event, snapshotId: string) => (await syncEngine()).pin(snapshotId))
  ipcMain.handle('sync:remove', async (_event, snapshotId: string) => (await syncEngine()).remove(snapshotId))

  ipcMain.handle('sync:get-settings', async () => {
    const { ws } = await scoped(context)
    const settings = await loadSyncSettings(ws)
    return { ...settings, consecutiveFailures: context.syncScheduler.failures }
  })
  ipcMain.handle(
    'sync:set-settings',
    async (_event, settings: { schedule: SyncSchedule; includeSessions: boolean }) => {
      const { ws } = await scoped(context)
      await saveSyncSettings(ws, {
        schedule: settings.schedule ?? 'off',
        includeSessions: settings.includeSessions !== false,
      })
      context.syncScheduler.configure(settings.schedule ?? 'off')
      return { ...(await loadSyncSettings(ws)), consecutiveFailures: context.syncScheduler.failures }
    },
  )

  // ---------- 统计（design 6.7.2） ----------
  ipcMain.handle(
    'stats:usage',
    async (_event, params: Parameters<StatsClient['usage']>[0]) => context.stats.usage(params),
  )
  ipcMain.handle(
    'stats:activations',
    async (_event, params: Parameters<StatsClient['activations']>[0]) => context.stats.activations(params),
  )
  ipcMain.handle('stats:teams', () => context.stats.teams())
  ipcMain.handle('stats:orgs', () => context.stats.orgs())

  // ---------- 权限策略与审计 ----------
  ipcMain.handle('permissions:rules', async () => {
    const { ws } = await scoped(context)
    return {
      workspace: await loadWorkspaceRules(ws.settingsFile),
      global: await loadGlobalRules(configFilePath()),
    }
  })
  ipcMain.handle('permissions:audit', async (_event, limit?: number) => {
    const { ws } = await scoped(context)
    return readAuditTail(ws.auditFile, limit ?? 50)
  })

  // ---------- MCP ----------
  ipcMain.handle('mcp:list', async () => {
    const { ws } = await scoped(context)
    return context.mcp.list(ws)
  })
  ipcMain.handle('mcp:save', async (_event, input: McpSaveInputWire) => {
    const { ws } = await scoped(context)
    const name = input.name.trim()
    if (!name) throw new Error(t('请填写 server 名称'))
    if (input.transport === 'stdio' && !input.command?.trim()) throw new Error(t('stdio 传输需要填写 command'))
    if (input.transport !== 'stdio' && !input.url?.trim()) throw new Error(t('{transport} 传输需要填写 URL', { transport: input.transport }))
    const file = input.scope === 'global' ? globalMcpFile() : workspaceMcpFile(ws)
    const existing = (await loadMcpFile(file))[name]
    const config: McpServerConfig = {
      transport: input.transport,
      command: input.command?.trim() || undefined,
      args: (input.args ?? []).filter((arg) => arg.length > 0),
      env: await materializeSecrets(name, input.env, context.secrets),
      headers: await materializeSecrets(name, input.headers, context.secrets),
      url: input.url?.trim() || undefined,
      approval: input.approval ?? 'ask',
      enabled:
        input.scope === 'global'
          ? { global: existing?.enabled?.global ?? true, workspaces: existing?.enabled?.workspaces ?? [] }
          : {
              global: existing?.enabled?.global,
              workspaces: [...new Set([...(existing?.enabled?.workspaces ?? []), ws.id])],
            },
    }
    await saveMcpServer(file, name, config)
    await context.mcp.reload(ws)
    return context.mcp.list(ws)
  })
  ipcMain.handle('mcp:remove', async (_event, name: string, scope: 'global' | 'workspace') => {
    const { ws } = await scoped(context)
    await saveMcpServer(scope === 'global' ? globalMcpFile() : workspaceMcpFile(ws), name, null)
    await context.mcp.reload(ws)
    return context.mcp.list(ws)
  })
  ipcMain.handle(
    'mcp:set-enabled',
    async (_event, name: string, scope: 'global' | 'workspace', enabled: boolean) => {
      const { ws } = await scoped(context)
      const file = scope === 'global' ? globalMcpFile() : workspaceMcpFile(ws)
      const current = (await loadMcpFile(file))[name]
      if (!current && scope === 'global') throw new Error(t('该 server 未在全局定义，无法全局启停'))
      const next: McpServerConfig = {
        ...(current ?? {}),
        enabled: {
          global: scope === 'global' ? enabled : current?.enabled?.global,
          workspaces:
            scope === 'workspace'
              ? enabled
                ? [...new Set([...(current?.enabled?.workspaces ?? []), ws.id])]
                : (current?.enabled?.workspaces ?? []).filter((id) => id !== ws.id)
              : (current?.enabled?.workspaces ?? []),
        },
      }
      await saveMcpServer(file, name, next)
      await context.mcp.reload(ws)
      return context.mcp.list(ws)
    },
  )
  ipcMain.handle('mcp:test', async (_event, name: string) => {
    const { ws } = await scoped(context)
    return context.mcp.test(ws, name)
  })

  // ---------- 云账户与用量上报（design 4.1 / 5.10） ----------
  ipcMain.handle('cloud:status', () => buildCloudStatus(context))
  ipcMain.handle('cloud:session', async () => {
    const result = await context.cloud.restore()
    return {
      loggedIn: result.ok,
      needsLogin: result.ok ? false : Boolean(result.needsLogin),
      error: result.error,
      code: result.code,
    }
  })
  ipcMain.handle('cloud:login', async (_event, serverUrl: string, email: string, password: string) => {
    await context.cloud.login(serverUrl, email, password)
    const { ws } = await scoped(context)
    await context.reporter.flush(ws, { force: true }).catch(() => undefined)
    // 登录后立即同步资源状态与激活快照（design 5.12.3）
    await context.statuses.check({ force: true }).catch(() => undefined)
    await reportScope(context, ws, 'global')
    return buildCloudStatus(context)
  })
  ipcMain.handle(
    'cloud:register',
    async (_event, serverUrl: string, email: string, displayName: string, password: string) => {
      await context.cloud.register(serverUrl, email, displayName, password)
      const { ws } = await scoped(context)
      await context.reporter.flush(ws, { force: true }).catch(() => undefined)
      return buildCloudStatus(context)
    },
  )
  ipcMain.handle('cloud:providers', async (_event, serverUrl: string) => context.cloud.listProviders(serverUrl))
  ipcMain.handle('diagnostics:export', async () => {
    const target = await dialog.showSaveDialog({
      title: t('导出诊断包'),
      defaultPath: join(app.getPath('downloads'), `hu-agent-diagnostics-${Date.now()}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    })
    if (target.canceled || !target.filePath) return { canceled: true }
    const report = await exportDiagnostics(target.filePath, app.getVersion())
    return { canceled: false, ...report }
  })
  ipcMain.handle('cloud:export-data', async () => {
    const document_ = await context.cloud.exportAccountData()
    const target = await dialog.showSaveDialog({
      title: t('导出我的数据'),
      defaultPath: join(app.getPath('downloads'), `hu-agent-data-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (target.canceled || !target.filePath) return { canceled: true }
    await writeFile(target.filePath, JSON.stringify(document_, null, 2), 'utf8')
    return { canceled: false, path: target.filePath }
  })
  ipcMain.handle('cloud:delete-account', async (_event, confirmEmail: string, password?: string) => {
    const result = await context.cloud.deleteAccount(confirmEmail, password)
    // 会话已被服务端撤销：通知界面回到登录门禁（ADR 0004）
    broadcastSessionLost(t('账号已注销，本地会话已失效'))
    return result
  })
  ipcMain.handle('cloud:sso-login', async (_event, serverUrl: string, providerId: string) => {
    // 系统浏览器 + 回环回调（design 6.12.3）
    const flow = new SsoLoginFlow(context.cloud, {
      openBrowser: (url) => shell.openExternal(url),
    })
    await flow.login(serverUrl, providerId)
    const { ws } = await scoped(context)
    await context.reporter.flush(ws, { force: true }).catch(() => undefined)
    await context.statuses.check({ force: true }).catch(() => undefined)
    await reportScope(context, ws, 'global')
    return buildCloudStatus(context)
  })
  ipcMain.handle('cloud:logout', async (_event, allDevices: boolean) => {
    await context.cloud.logout(Boolean(allDevices))
    return buildCloudStatus(context)
  })
  ipcMain.handle('cloud:devices', () => context.cloud.devices())
  ipcMain.handle('cloud:revoke-device', async (_event, deviceId: string) => {
    await context.cloud.revokeDevice(deviceId)
    return context.cloud.devices()
  })
  ipcMain.handle('cloud:flush', async () => {
    const { ws } = await scoped(context)
    return context.reporter.flush(ws, { force: true })
  })
  ipcMain.handle('cloud:clear-queue', async () => {
    const { ws } = await scoped(context)
    await context.reporter.clear(ws)
    return buildCloudStatus(context)
  })
}

interface SaveProviderInputWire {
  id: string
  apiType: ModelSettings['providers'][number]['apiType']
  baseUrl: string
  apiKey?: string | null
  apiKeyRef?: string | null
  models: ModelSettings['providers'][number]['models']
}

interface McpSaveInputWire {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  approval?: 'ask' | 'session' | 'always'
  scope: 'global' | 'workspace'
}

/** 从模型设置里取目标模型的上下文窗口（stats 视图用；找不到就退回第一个可用模型） */
function contextWindowOf(settings: ModelSettings, target?: string): number {
  const slash = (target ?? '').indexOf('/')
  const providerId = slash >= 0 ? (target ?? '').slice(0, slash) : ''
  const modelName = slash >= 0 ? (target ?? '').slice(slash + 1) : (target ?? '')
  const provider =
    settings.providers.find((item) => item.id === providerId) ??
    settings.providers.find((item) => item.models.some((model) => model.name === modelName)) ??
    settings.providers[0]
  const model = provider?.models.find((item) => item.name === modelName) ?? provider?.models[0]
  return model?.capabilities.contextWindow ?? 0
}

async function resolveSessionOptions(context: AppContext, sessionId: string): Promise<SessionOptionsView> {  const settings = await context.settings.load()
  const { sessions } = await scoped(context)
  const stored = await sessions.loadOptions(sessionId)
  return {
    model: stored.model ?? settings.defaults.primary,
    reasoningEffort: (stored.reasoningEffort ?? 'off') as ReasoningEffort,
  }
}

/** 语言视图：偏好 + 生效值 + 操作系统解析值（design 5.13） */
function localeView(): LocaleView {
  return { preference: getLocalePreference(), resolved: getLocale(), system: systemLocale() }
}

async function buildSettingsView(context: AppContext): Promise<import('../shared/ipc').SettingsView> {
  const settings = await context.settings.load()
  const secretsConfigured: Record<string, boolean> = {}
  const availableModels: import('../shared/ipc').ModelOptionView[] = []
  for (const provider of settings.providers) {
    if (provider.apiKeyRef) secretsConfigured[provider.apiKeyRef] = context.secrets.has(provider.apiKeyRef)
    for (const model of provider.models) {
      availableModels.push({
        target: `${provider.id}/${model.name}`,
        providerId: provider.id,
        name: model.name,
        contextWindow: model.capabilities.contextWindow,
        reasoningEffort: model.capabilities.reasoningEffort ?? false,
      })
    }
  }
  return {
    providers: settings.providers.map((provider) => ({ ...provider, apiKeyRef: provider.apiKeyRef ?? null })),
    defaults: settings.defaults,
    secretsConfigured,
    availableModels,
  }
}

/** 云账户状态（个人中心展示）：服务器地址、设备指纹、登录态与待上报数。 */
async function buildCloudStatus(context: AppContext): Promise<import('../shared/ipc').CloudStatusView> {
  const [config, loggedIn] = await Promise.all([context.cloud.config(), context.cloud.isLoggedIn()])
  const { ws } = await scoped(context)
  const pending = await context.reporter.pendingCount(ws)
  return {
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    loggedIn,
    user:
      loggedIn && config.userId
        ? {
            id: config.userId,
            email: config.email ?? '',
            displayName: config.displayName ?? '',
            locale: config.locale ?? 'zh-CN',
            isSystemAdmin: Boolean(config.isSystemAdmin),
          }
        : undefined,
    pending,
  }
}

/** Skill 列表（带市场来源与服务端状态；enabled 为实际生效值，design 5.12.2）。 */
async function buildSkillViews(context: AppContext, ws: WorkspacePaths): Promise<SkillView[]> {
  const [skills, installed, cache] = await Promise.all([
    context.skills.list(ws),
    context.installer.list(),
    context.statuses.load(),
  ])
  const byName = latestByName(installed)
  return skills.map((skill) => {
    const market = byName.get(skill.name)
    const entry = market ? cache.skills[market.skillId] : undefined
    const hard = entry ? isHardDisabled(entry.status) : false
    return {
      ...skill,
      intentEnabled: skill.enabled,
      enabled: skill.enabled && !hard,
      market: market
        ? { skillId: market.skillId, installedVersion: market.version, updateAvailable: false }
        : undefined,
      state: entry?.status,
      stateReason: entry?.reason,
      replacementVersion: entry?.replacementVersion,
    }
  })
}

function latestByName(installed: InstalledSkill[]): Map<string, InstalledSkill> {
  const map = new Map<string, InstalledSkill>()
  for (const item of installed) {
    const current = map.get(item.name)
    if (!current || compareSemver(item.version, current.version) > 0) map.set(item.name, item)
  }
  return map
}

function toMarketView(
  item: MarketSkill,
  installed: InstalledSkill[],
  cache: StatusCache,
): import('../shared/ipc').MarketSkillView {
  const mine = installed
    .filter((entry) => entry.skillId === item.id)
    .sort((a, b) => compareSemver(b.version, a.version))[0]
  const entry = cache.skills[item.id]
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    tags: item.tags,
    latestVersion: item.latestVersion,
    downloadCount: item.downloadCount,
    updatedAt: item.updatedAt,
    installedVersion: mine?.version ?? null,
    updateAvailable: Boolean(mine && item.latestVersion && compareSemver(item.latestVersion, mine.version) > 0),
    state: entry?.status,
    stateReason: entry?.reason,
    replacementVersion: entry?.replacementVersion,
  }
}

/** 上报某一作用域的激活快照（登录后调用，失败不影响主流程）。 */
async function reportScope(
  context: AppContext,
  ws: WorkspacePaths,
  scope: 'global' | 'workspace',
): Promise<void> {
  try {
    if (!(await context.cloud.isLoggedIn())) return
    const [config, skills, installed] = await Promise.all([
      context.cloud.config(),
      context.skills.list(ws),
      context.installer.list(),
    ])
    await reportActivationSnapshot({
      market: context.market,
      deviceId: config.deviceId,
      scope,
      workspaceId: scope === 'workspace' ? ws.id : null,
      skills,
      installed,
    })
  } catch (error) {
    console.warn(t('[market] 激活上报失败：'), error)
  }
}
