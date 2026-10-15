/** 工作空间域 IPC：列表/当前/切换/选择目录（design 5.6）。 */

import { dialog, ipcMain } from 'electron'

import { t } from '../i18n'
import { loadSyncSettings } from '../sync/scheduler'
import type { AppContext } from './context'

export function registerWorkspaceIpc(context: AppContext): void {
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
}
