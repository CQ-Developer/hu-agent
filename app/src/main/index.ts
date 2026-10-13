import { join } from 'node:path'

import { BrowserWindow, app, ipcMain, shell } from 'electron'

import { ModelGateway } from './model/gateway'
import { registerIpc, type AppContext } from './ipc'
import { SecretStore } from './config/secrets'
import { SettingsStore } from './config/settings-store'
import { configFilePath, secretsFilePath, usageLedgerPath } from './config/paths'
import { ArtifactStore } from './session/artifacts'
import { SessionStore } from './session/store'
import { createDefaultToolRegistry } from './tools/registry'
import { UsageLedger } from './usage/ledger'
import { ensureDefaultWorkspace } from './workspace'

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
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
  const workspace = await ensureDefaultWorkspace()
  const settings = new SettingsStore(configFilePath())
  await settings.load()
  const secrets = new SecretStore(secretsFilePath())
  await secrets.load()
  const sessions = new SessionStore(workspace.sessionDir)
  const artifacts = new ArtifactStore(workspace.artifactDir)
  await artifacts.init()
  const ledger = new UsageLedger(usageLedgerPath())
  const gateway = new ModelGateway({
    getSettings: () => settings.get(),
    getSecret: (ref) => secrets.get(ref),
  })

  const context: AppContext = {
    workspace,
    sessions,
    artifacts,
    ledger,
    settings,
    secrets,
    gateway,
    tools: createDefaultToolRegistry(),
  }
  registerIpc(context)
}

// 类型化 IPC 示例：渲染进程通过 window.huAgent.getVersion() 调用
ipcMain.handle('app:get-version', () => app.getVersion())

void app.whenReady().then(async () => {
  await bootstrap()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
