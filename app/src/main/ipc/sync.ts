/** 云同步域 IPC：状态/手动同步/版本与恢复/冲突处理/档位设置（design 5.11 / 6.6）。 */

import { ipcMain } from 'electron'

import { CloudSyncBackend } from '../sync/backend'
import { SyncEngine } from '../sync/engine'
import { loadSyncSettings, saveSyncSettings, type SyncSchedule } from '../sync/scheduler'
import { scoped, type AppContext } from './context'

export function registerSyncIpc(context: AppContext): void {
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
  ipcMain.handle('sync:resolve', async (_event, choice: 'keep-local' | 'cancel' | 'export-diff') => {
    const view = await (await syncEngine()).resolve(choice)
    // 冲突解除后重新武装定时同步（design 5.11.5）
    if (view.status !== 'conflict') {
      const { ws } = await scoped(context)
      context.syncScheduler.configure((await loadSyncSettings(ws)).schedule)
    }
    return view
  })
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
}
