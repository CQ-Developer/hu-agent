/** 主进程与渲染进程之间的接口契约（类型化 IPC）。 */

import type { AgentEvent } from './events'

export type ReasoningEffortView = 'off' | 'low' | 'medium' | 'high'

export type ApiTypeView = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

export interface ModelCapabilitiesView {
  tools: boolean
  vision?: boolean
  reasoningEffort?: boolean
  contextWindow: number
  maxOutput?: number
}

export interface ModelEntryView {
  name: string
  roles?: ('primary' | 'fast')[]
  capabilities: ModelCapabilitiesView
}

export interface ProviderView {
  id: string
  apiType: ApiTypeView
  baseUrl: string
  apiKeyRef: string | null
  models: ModelEntryView[]
}

/** 输入框模型下拉选项（跨供应商展开） */
export interface ModelOptionView {
  target: string
  providerId: string
  name: string
  contextWindow: number
  reasoningEffort: boolean
}

export interface SettingsView {
  providers: ProviderView[]
  defaults: { primary: string; fast?: string }
  secretsConfigured: Record<string, boolean>
  availableModels: ModelOptionView[]
}

export interface SaveProviderInput {
  id: string
  apiType: ApiTypeView
  baseUrl: string
  models: ModelEntryView[]
  /** 明文密钥只在 IPC 中传递一次，主进程立即加密存储 */
  apiKey?: string | null
}

export interface SessionMetaView {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface SessionOptionsView {
  model: string
  reasoningEffort: ReasoningEffortView
}

export interface SessionUsageView {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheHitRate: number
  contextWindow: number
  contextRemainingPercent: number
}

export type SessionItemView =
  | {
      kind: 'message'
      id: string
      role: 'user' | 'assistant' | 'system'
      text: string
      /** 思考内容（design 5.2.6）：仅展示，不回传模型 */
      reasoning?: string
      createdAt: string
    }
  | {
      kind: 'tool'
      id: string
      name: string
      input: unknown
      status?: 'ok' | 'error' | 'denied' | 'timeout'
      output?: string
      durationMs?: number
      truncated?: boolean
      artifactPath?: string
      createdAt: string
    }

export interface UsageStatsView {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }>
}

export interface WorkspaceInfoView {
  id: string
  name: string
  root: string
}

export interface SkillView {
  name: string
  description: string
  version?: string
  whenToUse?: string
  requires?: { tools?: string[]; bins?: string[]; network?: boolean }
  scope: 'global' | 'workspace'
  path: string
  /** 用户意图（本地 skills.json 记录） */
  intentEnabled: boolean
  /** 实际生效 = 意图 ∧ 服务端状态允许（design 5.12） */
  enabled: boolean
  /** 市场来源信息（本地 Skill 无此字段） */
  market?: { skillId: string; installedVersion: string; updateAvailable: boolean }
  state?: 'active' | 'delisted' | 'disabled' | 'revoked' | 'not_found' | 'unknown'
  stateReason?: string
  replacementVersion?: string
}

export interface MarketSkillView {
  id: string
  name: string
  description: string
  tags: string[]
  latestVersion: string | null
  downloadCount: number
  updatedAt: string
  installedVersion: string | null
  updateAvailable: boolean
  state?: 'active' | 'delisted' | 'disabled' | 'revoked' | 'not_found' | 'unknown'
  stateReason?: string
  replacementVersion?: string
}

export interface MarketVersionView {
  version: string
  status: string
  digest: string
  sizeBytes: number
  fileCount: number
  changelog: string | null
  createdAt: string
}

export interface MarketDetailView extends MarketSkillView {
  disabledReason: string | null
  skillMd: string
  scripts: string[]
  requires: { tools: string[]; bins: string[]; network: boolean }
  versions: MarketVersionView[]
}

export interface MarketInstallResultView {
  name: string
  version: string
  files: number
}

export interface InstalledSkillView {
  skillId: string
  name: string
  version: string
  digest: string
  installedAt: string
  state?: 'active' | 'delisted' | 'disabled' | 'revoked' | 'not_found' | 'unknown'
  stateReason?: string
  replacementVersion?: string
}

export interface MarketCheckResultView {
  checked: number
  skipped: boolean
  error?: string
}

export type SyncStatusCode =
  | 'unlinked'
  | 'up-to-date'
  | 'local-changes'
  | 'remote-changes'
  | 'conflict'
  | 'error'

export interface SyncSettingsView {
  schedule: 'off' | '15m' | '30m' | '1h' | '6h' | '24h'
  includeSessions: boolean
  /** 连续自动同步失败次数（≥3 时 UI 提醒） */
  consecutiveFailures: number
}

export interface SyncConflictView {
  detectedAt: string
  remoteVersion: number
  remoteDigest: string | null
  localDigest: string
  localFiles: number
  diff: { added: string[]; modified: string[]; removed: string[] }
  diffPath?: string
}

export interface SyncStatusView {
  status: SyncStatusCode
  workspaceId?: string
  lastVersion?: number
  lastSyncedAt?: string
  lastError?: string
  localFiles: number
  localBytes: number
  localDigest: string
  remoteVersion?: number
  remoteManifestDigest?: string
  quota?: { usedBytes: number; limitBytes: number }
  conflict?: SyncConflictView
}

export interface SyncVersionView {
  id: string
  version: number
  sizeBytes: number
  fileCount: number
  pinned: boolean
  createdAt: string
  digest: string | null
  latest: boolean
}

export type StatsScope = 'self' | 'team' | 'org' | 'global'
export type UsageGroupBy = 'day' | 'model' | 'member' | 'team' | 'org'

export interface UsageTotalsView {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  errors: number
  estimatedCost: number
}

export interface UsageRowView {
  key: string
  day?: string | null
  userId?: string | null
  teamId?: string | null
  orgId?: string | null
  provider?: string | null
  model?: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  errors: number
  estimatedCost: number
}

export interface UsageStatsViewResult {
  scope: string
  dateFrom: string
  dateTo: string
  groupBy: string
  currency: string
  totals: UsageTotalsView
  rows: UsageRowView[]
}

export interface ActivationView {
  userId: string
  email: string
  resourceType: string
  refId: string | null
  name: string
  version: string | null
  enabled: boolean
  deviceCount: number
  lastReportedAt: string
  serverState: string | null
}

export interface StatsTeamOption {
  id: string
  name: string
  orgId: string
  myRole: string | null
}

export interface StatsOrgOption {
  id: string
  name: string
  slug: string
  role: string | null
}

export interface PolicyRuleView {
  tools: string[]
  paths?: string[]
  action: 'allow' | 'ask' | 'deny'
}

export interface AuditEntryView {
  ts: string
  tool: string
  summary: string
  decision: string
  scope: string
}

export interface McpServerView {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  summary: string
  command?: string
  args: string[]
  url?: string
  env: Record<string, string>
  headers: Record<string, string>
  scope: 'global' | 'workspace' | 'both'
  enabledGlobal: boolean
  enabledWorkspace: boolean
  enabled: boolean
  approval: 'ask' | 'session' | 'always'
  status: 'disabled' | 'idle' | 'connecting' | 'connected' | 'error'
  toolCount: number
  lastError?: string
  envKeys: string[]
  headerKeys: string[]
  tools: { name: string; description: string }[]
}

export interface McpSaveInput {
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

export interface McpTestResultView {
  ok: boolean
  toolCount: number
  error?: string
  tools: { name: string; description: string }[]
}

export interface CloudUserView {
  id: string
  email: string
  displayName: string
  locale: string
  isSystemAdmin: boolean
}

export interface CloudDeviceView {
  id: string
  deviceId: string
  platform: string
  appVersion: string
  name: string | null
  lastSeenAt: string | null
  createdAt: string
  current: boolean
}

export interface CloudStatusView {
  serverUrl: string
  deviceId: string
  loggedIn: boolean
  user?: CloudUserView
  pending: number
}

/** 启动门禁的会话探测结果（ADR 0004 / D16）。 */
export interface CloudSessionView {
  loggedIn: boolean
  /** true：需要用户登录；false 且 error 存在：有登录态但服务端不可达，只可重试 */
  needsLogin: boolean
  error?: string
  code?: string
}

export interface CloudFlushResultView {
  sent: number
  pending: number
  error?: string
}

export interface SessionSearchHitView {
  sessionId: string
  title: string
  snippet: string
  updatedAt: string
}

export interface HuAgentApi {
  getVersion(): Promise<string>
  settings: {
    get(): Promise<SettingsView>
    saveProvider(input: SaveProviderInput): Promise<SettingsView>
    removeProvider(id: string): Promise<SettingsView>
    setDefault(role: 'primary' | 'fast', target: string): Promise<SettingsView>
  }
  sessions: {
    list(): Promise<SessionMetaView[]>
    create(): Promise<SessionMetaView>
    items(sessionId: string): Promise<SessionItemView[]>
    rename(sessionId: string, title: string): Promise<void>
    options(sessionId: string): Promise<SessionOptionsView>
    setOptions(sessionId: string, options: SessionOptionsView): Promise<SessionOptionsView>
    stats(sessionId: string): Promise<SessionUsageView>
    search(query: string): Promise<SessionSearchHitView[]>
  }
  agent: {
    send(sessionId: string, text: string): Promise<void>
    cancel(sessionId: string): Promise<void>
    decideApproval(requestId: string, choice: 'allow_once' | 'allow_session' | 'allow_always' | 'deny'): Promise<void>
    answerGuide(requestId: string, value: string): Promise<void>
    onEvent(listener: (event: AgentEvent) => void): () => void
  }
  usage: {
    stats(): Promise<UsageStatsView>
  }
  skills: {
    list(): Promise<SkillView[]>
    setEnabled(name: string, scope: 'global' | 'workspace', enabled: boolean): Promise<SkillView[]>
  }
  market: {
    list(params?: { q?: string; tag?: string; sort?: 'updated' | 'name' | 'downloads' }): Promise<MarketSkillView[]>
    detail(skillId: string): Promise<MarketDetailView>
    install(skillId: string, version: string): Promise<MarketInstallResultView>
    uninstall(skillId: string): Promise<number>
    installed(): Promise<InstalledSkillView[]>
    checkStatus(force?: boolean): Promise<MarketCheckResultView>
  }
  sync: {
    status(): Promise<SyncStatusView>
    now(): Promise<SyncStatusView>
    versions(): Promise<SyncVersionView[]>
    restore(version: number): Promise<SyncStatusView>
    resolve(choice: 'keep-local' | 'cancel' | 'export-diff'): Promise<SyncStatusView>
    pin(snapshotId: string): Promise<void>
    remove(snapshotId: string): Promise<void>
    settings(): Promise<SyncSettingsView>
    setSettings(settings: { schedule: SyncSettingsView['schedule']; includeSessions: boolean }): Promise<SyncSettingsView>
    /** 定时同步结果（自动触发的同步状态推送） */
    onEvent(listener: (view: SyncStatusView) => void): () => void
  }
  stats: {
    usage(params: {
      scope: StatsScope
      from: string
      to: string
      groupBy: UsageGroupBy
      teamId?: string
      orgId?: string
    }): Promise<UsageStatsViewResult>
    activations(params: {
      scope: StatsScope
      teamId?: string
      orgId?: string
      type?: 'skill' | 'mcp'
    }): Promise<ActivationView[]>
    teams(): Promise<StatsTeamOption[]>
    orgs(): Promise<StatsOrgOption[]>
  }
  permissions: {
    rules(): Promise<{ workspace: PolicyRuleView[]; global: PolicyRuleView[] }>
    audit(limit?: number): Promise<AuditEntryView[]>
  }
  mcp: {
    list(): Promise<McpServerView[]>
    save(input: McpSaveInput): Promise<McpServerView[]>
    remove(name: string, scope: 'global' | 'workspace'): Promise<McpServerView[]>
    setEnabled(name: string, scope: 'global' | 'workspace', enabled: boolean): Promise<McpServerView[]>
    test(name: string): Promise<McpTestResultView>
  }
  cloud: {
    status(): Promise<CloudStatusView>
    session(): Promise<CloudSessionView>
    login(serverUrl: string, email: string, password: string): Promise<CloudStatusView>
    register(serverUrl: string, email: string, displayName: string, password: string): Promise<CloudStatusView>
    logout(allDevices?: boolean): Promise<CloudStatusView>
    devices(): Promise<CloudDeviceView[]>
    revokeDevice(deviceId: string): Promise<CloudDeviceView[]>
    flush(): Promise<CloudFlushResultView>
    clearQueue(): Promise<CloudStatusView>
    /** 会话被服务端撤销时触发（如设备被吊销/账号被禁用） */
    onSessionLost(listener: (reason: string) => void): () => void
  }
  workspace: {
    list(): Promise<WorkspaceInfoView[]>
    active(): Promise<WorkspaceInfoView>
    setActive(id: string): Promise<WorkspaceInfoView>
    /** 打开目录选择框；取消返回 null */
    pick(): Promise<WorkspaceInfoView | null>
  }
}
