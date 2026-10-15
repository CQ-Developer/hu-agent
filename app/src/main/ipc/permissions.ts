/** 权限策略与审计域 IPC（design 5.5）。 */

import { ipcMain } from 'electron'

import { configFilePath } from '../config/paths'
import { readAuditTail } from '../permissions/audit'
import { loadGlobalRules, loadWorkspaceRules } from '../workspace_settings'
import { scoped, type AppContext } from './context'

export function registerPermissionsIpc(context: AppContext): void {
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
}
