import { join } from 'node:path'

import { BrowserWindow, Menu, app, shell } from 'electron'

import { ModelGateway } from './model/gateway'
import { broadcastInteraction, registerIpc, type AppContext } from './ipc'
import { SecretStore } from './config/secrets'
import { SettingsStore } from './config/settings-store'
import { configFilePath, secretsFilePath, usageLedgerPath, workspacesIndexFile } from './config/paths'
import { InteractionBroker } from './permissions/broker'
import { SkillManager } from './skills/manager'
import { createDefaultToolRegistry } from './tools/registry'
import { UsageLedger } from './usage/ledger'
import { WorkspaceManager } from './workspace'

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
  const workspaces = new WorkspaceManager(workspacesIndexFile())
  await workspaces.init()

  const settings = new SettingsStore(configFilePath())
  await settings.load()
  const secrets = new SecretStore(secretsFilePath())
  await secrets.load()
  const ledger = new UsageLedger(usageLedgerPath())
  const gateway = new ModelGateway({
    getSettings: () => settings.get(),
    getSecret: (ref) => secrets.get(ref),
  })
  const interactions = new InteractionBroker({ broadcast: broadcastInteraction })

  const context: AppContext = {
    workspaces,
    settings,
    secrets,
    gateway,
    tools: createDefaultToolRegistry(),
    ledger,
    interactions,
    skills: new SkillManager(),
    grants: new Map(),
    sessionStores: new Map(),
    artifactStores: new Map(),
    auditLogs: new Map(),
  }
  registerIpc(context)
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
