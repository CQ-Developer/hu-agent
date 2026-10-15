/** Skill 域 IPC：列表与启停（design 5.7）。 */

import { ipcMain } from 'electron'

import type { AppContext } from './context'
import { scoped } from './context'
import { buildSkillViews, reportScope } from './shared'

export function registerSkillsIpc(context: AppContext): void {
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
}
