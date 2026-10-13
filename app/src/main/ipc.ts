/** 主进程 IPC 注册（design 5.1/5.5/5.6）。 */

import { BrowserWindow, app, dialog, ipcMain } from 'electron'

import { ModelGateway } from './model/gateway'
import type { ModelSettings, ReasoningEffort } from './model/types'
import { runTurn } from './agent/loop'
import type { SecretStore } from './config/secrets'
import type { SettingsStore } from './config/settings-store'
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
import type { SessionOptionsView } from '../shared/ipc'
import type { AgentEvent, ApprovalRequestView, GuideRequestView } from '../shared/events'
import type { ToolRegistry } from './tools/registry'
import type { UsageLedger } from './usage/ledger'
import type { WorkspaceManager, WorkspacePaths } from './workspace'
import { appendWorkspaceRule, loadGlobalRules, loadWorkspaceRules } from './workspace-settings'

export interface AppContext {
  workspaces: WorkspaceManager
  settings: SettingsStore
  secrets: SecretStore
  gateway: ModelGateway
  tools: ToolRegistry
  ledger: UsageLedger
  interactions: InteractionBroker
  skills: SkillManager
  mcp: McpManager
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
    const { model } = context.gateway.resolve(options.model)
    return computeSessionUsage(lines, model.capabilities.contextWindow)
  })
  ipcMain.handle('sessions:search', async (_event, query: string) => (await scoped(context)).sessions.search(query))

  // ---------- Agent ----------
  ipcMain.handle('agent:send', async (_event, sessionId: string, text: string) => {
    if (activeTurns.has(sessionId)) throw new Error('该会话已有运行中的任务')
    const { ws, sessions, artifacts } = await scoped(context)
    const permissions = await buildEngine(context, ws)
    const settings = await context.settings.load()
    const controller = new AbortController()
    activeTurns.set(sessionId, controller)
    try {
      await runTurn(
        {
          gateway: context.gateway,
          tools: context.tools,
          sessions,
          artifacts,
          ledger: context.ledger,
          permissions,
          interactions: context.interactions,
          emit: broadcastEvent,
          workspaceRoot: ws.root,
          fastTarget: settings.defaults.fast ?? settings.defaults.primary,
          skillSection: await context.skills.systemPromptSection(ws),
          extraTools: await context.mcp.tools(ws),
          telemetry: {
            record: async (input) => {
              try {
                await context.reporter.enqueue(ws, input)
                // 入队后后台尝试上报（未到退避时间会自动跳过）
                void context.reporter.tick([ws])
              } catch (error) {
                console.warn('[telemetry] 入队失败：', error)
              }
            },
          },
        },
        { sessionId, userText: text, signal: controller.signal },
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
    return { id: ws.id, name: ws.name, root: ws.root }
  })
  ipcMain.handle('workspace:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择工作空间目录',
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
    return context.skills.list(ws)
  })
  ipcMain.handle(
    'skills:set-enabled',
    async (_event, name: string, scope: 'global' | 'workspace', enabled: boolean) => {
      const { ws } = await scoped(context)
      if (enabled) await context.skills.setEnabled(ws, name, scope)
      else await context.skills.setDisabled(ws, name, scope)
      return context.skills.list(ws)
    },
  )

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
    if (!name) throw new Error('请填写 server 名称')
    if (input.transport === 'stdio' && !input.command?.trim()) throw new Error('stdio 传输需要填写 command')
    if (input.transport !== 'stdio' && !input.url?.trim()) throw new Error(`${input.transport} 传输需要填写 URL`)
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
      if (!current && scope === 'global') throw new Error('该 server 未在全局定义，无法全局启停')
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
  ipcMain.handle('cloud:login', async (_event, serverUrl: string, email: string, password: string) => {
    await context.cloud.login(serverUrl, email, password)
    const { ws } = await scoped(context)
    await context.reporter.flush(ws, { force: true }).catch(() => undefined)
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

async function resolveSessionOptions(context: AppContext, sessionId: string): Promise<SessionOptionsView> {  const settings = await context.settings.load()
  const { sessions } = await scoped(context)
  const stored = await sessions.loadOptions(sessionId)
  return {
    model: stored.model ?? settings.defaults.primary,
    reasoningEffort: (stored.reasoningEffort ?? 'off') as ReasoningEffort,
  }
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
