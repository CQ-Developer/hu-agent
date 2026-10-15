/** 统计域 IPC：服务端用量/激活/组织/团队统计与本地账本（design 6.7.2）。 */

import { ipcMain } from 'electron'

import type { StatsClient } from '../stats/client'
import type { AppContext } from './context'

export function registerStatsIpc(context: AppContext): void {
  ipcMain.handle('usage:stats', () => context.ledger.stats())
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
}
