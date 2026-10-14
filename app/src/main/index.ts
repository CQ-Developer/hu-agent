import { join } from 'node:path'
import { appendFile, mkdir } from 'node:fs/promises'

import { BrowserWindow, Menu, app, shell } from 'electron'

import { broadcastInteraction, broadcastSessionLost, broadcastSyncEvent, registerIpc, type AppContext } from './ipc'
import { SecretStore } from './config/secrets'
import { createModelSettingsStore } from './config/pi_model_settings'
import { configFilePath, cloudConfigFile, globalDir, secretsFilePath, usageLedgerPath, workspacesIndexFile } from './config/paths'
import { CloudStore } from './cloud/store'
import { CloudClient } from './cloud/client'
import { UsageReporter } from './cloud/reporter'
import { MarketClient } from './market/client'
import { SkillInstaller } from './market/installer'
import { ResourceStatusService } from './market/status'
import { SyncEngine } from './sync/engine'
import { CloudSyncBackend } from './sync/backend'
import { SyncScheduler, loadSyncSettings } from './sync/scheduler'
import { StatsClient } from './stats/client'
import { InteractionBroker } from './permissions/broker'
import { McpManager } from './mcp/manager'
import { SkillManager } from './skills/manager'
import { FileLogger } from './logging'
import { createDurableTurnRunner } from './agent/durable_runner'
import { createPiRuntime } from './model/pi_runtime'
import { UsageLedger } from './usage/ledger'
import { WorkspaceManager } from './workspace'
import { initI18n, t } from './i18n'

/** 移除无意义的默认应用菜单栏（Windows/Linux 完全移除；macOS 保留最小菜单以维持系统快捷键）。 */
function configureApplicationMenu(): void {
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]))
    return
  }
  Menu.setApplicationMenu(null)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.on('ready-to-show', () => window.show())

  // 外链一律交给系统浏览器（design 5.1 安全基线）
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

async function bootstrap(): Promise<void> {
  // 文件日志（10MB × 5 滚动）最先安装，后续所有日志同时落盘
  const logger = new FileLogger()
  logger.install()
  // 语言必须在产生任何用户可见文案前初始化（design 5.13）
  await initI18n(configFilePath())
  console.log(t('hu-agent {0} 启动（{platform} {arch}）', { 0: app.getVersion(), platform: process.platform, arch: process.arch }))

  const workspaces = new WorkspaceManager(workspacesIndexFile())
  await workspaces.init()

  const secrets = new SecretStore(secretsFilePath())
  await secrets.load()

  // 模型设置来源（R3 切换）：providers 存 pi 的 models.json，defaults 存 config.json；
  // 接口与旧 SettingsStore 同形，因此 IPC 层的调用点无需改动。
  const settings = createModelSettingsStore({
    configPath: configFilePath(),
    hasKey: (providerId) => secrets.has(`model:${providerId}`),
  })
  await settings.load()

  // pi 运行时（长生命周期）：所有工作空间的会话服务共用同一份 models 集合；
  // 设置页保存/删除 provider 后由 ipc.ts 调用 refresh() 重新注册。
  const runtime = createPiRuntime({ getSecret: (ref) => secrets.get(ref) })
  await runtime.refresh()

  const ledger = new UsageLedger(usageLedgerPath())
  const interactions = new InteractionBroker({ broadcast: broadcastInteraction })

  // 云账户与上报器必须共享同一个 CloudClient（access token 只存内存）；
  // 会话被服务端拒绝时广播给界面，强制退回登录门禁（ADR 0004 / D16）
  const cloud = new CloudClient(secrets, new CloudStore(cloudConfigFile()), app.getVersion(), {
    onSessionLost: (reason) => broadcastSessionLost(reason),
  })
  const reporter = new UsageReporter(cloud, app.getVersion())
  const market = new MarketClient(cloud)
  const installer = new SkillInstaller(market)
  const statuses = new ResourceStatusService(market, installer, undefined, {
    // 硬停用写本地审计（design 5.12.4）
    onHardDisabled: async (entry) => {
      const file = join(globalDir(), 'logs', 'resource-status.jsonl')
      await mkdir(join(globalDir(), 'logs'), { recursive: true })
      await appendFile(
        file,
        `${JSON.stringify({ ts: new Date().toISOString(), action: 'resource.hard_disabled', ...entry })}\n`,
        'utf8',
      )
    },
  })

  // 定时同步（design 5.11.5）：每次 tick 现取当前工作空间与档位，冲突时自动暂停
  const syncScheduler = new SyncScheduler({
    run: async () => {
      const ws = await workspaces.active()
      const syncSettings = await loadSyncSettings(ws)
      const engine = new SyncEngine(new CloudSyncBackend(cloud), ws, {
        includeSessions: syncSettings.includeSessions,
      })
      return engine.syncNow()
    },
    onResult: (view) => {
      broadcastSyncEvent(view)
      if (view.status === 'error') console.warn(t('[sync] 自动同步失败：'), view.lastError)
    },
  })

  const context: AppContext = {
    workspaces,
    settings,
    secrets,
    runtime,
    // 每回合构造 runner：工作空间相关的依赖（权限引擎、会话服务、产物存储、技能段、遥测出口、MCP 工具）
    // 在这里注入；回合由 pi-durable harness 跑（装配见 agent/durable_runner.ts）。
    createRunner: (options) =>
      createDurableTurnRunner({
        sessions: options.sessions,
        permissions: options.permissions,
        interactions,
        artifacts: options.artifacts,
        ledger,
        workspaceRoot: options.workspaceRoot,
        ...(options.telemetry ? { telemetry: options.telemetry } : {}),
        ...(options.skillSection ? { skillSection: options.skillSection } : {}),
        ...(options.extraTools ? { extraTools: options.extraTools } : {}),
      }),
    ledger,
    interactions,
    skills: new SkillManager(),
    mcp: new McpManager(secrets, app.getVersion()),
    market,
    installer,
    statuses,
    syncScheduler,
    stats: new StatsClient(cloud),
    cloud,
    reporter,
    grants: new Map(),
    sessionStores: new Map(),
    artifactStores: new Map(),
    auditLogs: new Map(),
  }
  registerIpc(context)

  // 后台预热当前工作空间的 MCP 连接（npx 首次拉包可能较慢，不阻塞首轮对话）
  void context.workspaces
    .active()
    .then((ws) => context.mcp.tools(ws))
    .catch(() => undefined)

  // 用量上报：启动时尝试一次 + 每 60s 扫描（退避与积压判定在 reporter 内部）
  const tickReporter = async (): Promise<void> => {
    try {
      await context.reporter.tick(await context.workspaces.list())
    } catch (error) {
      console.warn(t('[telemetry] tick 失败：'), error)
    }
  }
  void tickReporter()
  const reporterTimer = setInterval(() => void tickReporter(), 60_000)

  // 资源状态同步：启动后 30s 首次检查，之后每 6 小时（design 5.12.3）
  context.statuses.start()

  // 定时同步：按当前工作空间的档位启动（默认关闭）
  void context.workspaces
    .active()
    .then(async (ws) => syncScheduler.configure((await loadSyncSettings(ws)).schedule))
    .catch(() => undefined)

  // 退出时回收所有 MCP 子进程（design 5.8.2）
  app.on('before-quit', () => {
    clearInterval(reporterTimer)
    context.statuses.stop()
    syncScheduler.stop()
    void context.mcp.closeAll()
    logger.close()
  })
}

// 所有 IPC 在 bootstrap() -> registerIpc() 中统一注册（见 main/ipc.ts）
void app.whenReady().then(async () => {
  configureApplicationMenu()
  await bootstrap()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
