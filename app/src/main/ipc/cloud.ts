/** 云账户域 IPC：登录/会话/设备/数据导出与注销、诊断包导出（design 4.1 / 5.10 / 6.12）。 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { app, dialog, ipcMain, shell } from 'electron'

import { SsoLoginFlow } from '../cloud/sso'
import { exportDiagnostics } from '../diagnostics'
import { t } from '../i18n'
import { broadcastSessionLost } from './broadcast'
import { scoped, type AppContext } from './context'
import { reportScope } from './shared'

export function registerCloudIpc(context: AppContext): void {
  ipcMain.handle('cloud:update-locale', async (_event, locale: 'zh-CN' | 'en-US') => {
    // 未登录/离线时静默失败：本地语言已切换（users.locale 仅影响通知与邮件）
    await context.cloud.updateLocale(locale).catch(() => undefined)
  })
  ipcMain.handle('cloud:status', () => buildCloudStatus(context))
  ipcMain.handle('cloud:session', async () => {
    const result = await context.cloud.restore()
    return {
      loggedIn: result.ok,
      needsLogin: result.ok ? false : Boolean(result.needsLogin),
      error: result.error,
      code: result.code,
    }
  })
  ipcMain.handle('cloud:login', async (_event, serverUrl: string, email: string, password: string) => {
    await context.cloud.login(serverUrl, email, password)
    const { ws } = await scoped(context)
    await context.reporter.flush(ws, { force: true }).catch(() => undefined)
    // 登录后立即同步资源状态与激活快照（design 5.12.3）
    await context.statuses.check({ force: true }).catch(() => undefined)
    await reportScope(context, ws, 'global')
    return buildCloudStatus(context)
  })
  ipcMain.handle(
    'cloud:register',
    async (_event, serverUrl: string, email: string, displayName: string, password: string) => {
      await context.cloud.register(serverUrl, email, displayName, password)
      const { ws } = await scoped(context)
      await context.reporter.flush(ws, { force: true }).catch(() => undefined)
      return buildCloudStatus(context)
    },
  )
  ipcMain.handle('cloud:providers', async (_event, serverUrl: string) => context.cloud.listProviders(serverUrl))
  ipcMain.handle('diagnostics:export', async () => {
    const target = await dialog.showSaveDialog({
      title: t('导出诊断包'),
      defaultPath: join(app.getPath('downloads'), `hu-agent-diagnostics-${Date.now()}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    })
    if (target.canceled || !target.filePath) return { canceled: true }
    const report = await exportDiagnostics(target.filePath, app.getVersion())
    return { canceled: false, ...report }
  })
  ipcMain.handle('cloud:export-data', async () => {
    const document_ = await context.cloud.exportAccountData()
    const target = await dialog.showSaveDialog({
      title: t('导出我的数据'),
      defaultPath: join(app.getPath('downloads'), `hu-agent-data-${Date.now()}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (target.canceled || !target.filePath) return { canceled: true }
    await writeFile(target.filePath, JSON.stringify(document_, null, 2), 'utf8')
    return { canceled: false, path: target.filePath }
  })
  ipcMain.handle('cloud:delete-account', async (_event, confirmEmail: string, password?: string) => {
    const result = await context.cloud.deleteAccount(confirmEmail, password)
    // 会话已被服务端撤销：通知界面回到登录门禁（ADR 0004）
    broadcastSessionLost(t('账号已注销，本地会话已失效'))
    return result
  })
  ipcMain.handle('cloud:sso-login', async (_event, serverUrl: string, providerId: string) => {
    // 系统浏览器 + 回环回调（design 6.12.3）
    const flow = new SsoLoginFlow(context.cloud, {
      openBrowser: (url) => shell.openExternal(url),
    })
    await flow.login(serverUrl, providerId)
    const { ws } = await scoped(context)
    await context.reporter.flush(ws, { force: true }).catch(() => undefined)
    await context.statuses.check({ force: true }).catch(() => undefined)
    await reportScope(context, ws, 'global')
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

/** 云账户状态（个人中心展示）：服务器地址、设备指纹、登录态与待上报数。 */
async function buildCloudStatus(context: AppContext): Promise<import('../../shared/ipc').CloudStatusView> {
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
