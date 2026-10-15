/** 市场域 IPC：Skill 市场（design 5.7.4）与 MCP 市场（design 6.5）的浏览/安装/状态。 */

import { ipcMain } from 'electron'

import { t } from '../i18n'
import type { MarketSkill } from '../market/client'
import type { InstalledSkill } from '../market/installer'
import { buildMarketMcpConfig } from '../market/mcp_install'
import type { StatusCache } from '../market/status'
import { globalMcpFile, listMarketMcpRefs, saveMcpServer, workspaceMcpFile } from '../mcp/config'
import { compareSemver } from '../skills/parser'
import { scoped, type AppContext } from './context'
import { marketStateFields, reportScope } from './shared'

export function registerMarketIpc(context: AppContext): void {
  ipcMain.handle('market:list', async (_event, params?: Record<string, string>) => {
    const [result, installed, cache] = await Promise.all([
      context.market.listSkills({
        q: params?.q,
        tag: params?.tag,
        sort: params?.sort as 'updated' | 'name' | 'downloads' | undefined,
      }),
      context.installer.list(),
      context.statuses.load(),
    ])
    return result.items.map((item) => toMarketView(item, installed, cache))
  })
  ipcMain.handle('market:detail', async (_event, skillId: string) => {
    const [detail, installed, cache] = await Promise.all([
      context.market.skillDetail(skillId),
      context.installer.list(),
      context.statuses.load(),
    ])
    const view = toMarketView(detail, installed, cache)
    const front = detail.manifest?.frontMatter ?? {}
    return {
      ...view,
      disabledReason: detail.disabledReason ?? null,
      skillMd: detail.skillMd ?? '',
      scripts: detail.manifest?.scripts ?? [],
      requires: {
        tools: front.requires?.tools ?? [],
        bins: front.requires?.bins ?? [],
        network: front.requires?.network ?? false,
      },
      versions: detail.versions.map((version) => ({
        version: version.version,
        status: version.status,
        digest: version.digest,
        sizeBytes: version.sizeBytes,
        fileCount: version.fileCount,
        changelog: version.changelog,
        createdAt: version.createdAt,
      })),
    }
  })
  ipcMain.handle('market:install', async (_event, skillId: string, version: string) => {
    const { ws } = await scoped(context)
    const result = await context.installer.install(skillId, version)
    await context.statuses.check({ force: true })
    await reportScope(context, ws, 'global')
    return { name: result.skill.name, version: result.skill.version, files: result.files }
  })
  ipcMain.handle('market:uninstall', async (_event, skillId: string) => {
    const { ws } = await scoped(context)
    const installed = (await context.installer.list()).filter((item) => item.skillId === skillId)
    for (const item of installed) {
      // 先从启用列表移除（design 5.7.4：卸载 = 从启用列表移除 + 删除目录）
      for (const scope of ['global', 'workspace'] as const) {
        try {
          await context.skills.setDisabled(ws, item.name, scope)
        } catch {
          // 未启用或不存在：忽略
        }
      }
    }
    const removed = await context.installer.uninstall(skillId)
    await reportScope(context, ws, 'global')
    return removed
  })
  ipcMain.handle('market:installed', async () => {
    const [installed, cache] = await Promise.all([context.installer.list(), context.statuses.load()])
    return installed.map((item) => {
      const entry = cache.skills[item.skillId]
      return {
        skillId: item.skillId,
        name: item.name,
        version: item.version,
        digest: item.digest,
        installedAt: item.installedAt,
        ...marketStateFields(entry),
      }
    })
  })
  ipcMain.handle('market:check-status', async (_event, force?: boolean) => {
    return context.statuses.check({ force: force ?? true })
  })

  // ---------- MCP 市场 ----------
  ipcMain.handle('market:mcp-list', async (_event, params?: Record<string, string>) => {
    const { ws } = await scoped(context)
    const [result, installed, cache] = await Promise.all([
      context.market.listMcpServers({
        q: params?.q,
        tag: params?.tag,
        sort: params?.sort as 'updated' | 'name' | undefined,
      }),
      listMarketMcpRefs([globalMcpFile(), workspaceMcpFile(ws)]),
      context.statuses.load(),
    ])
    return result.items.map((item) => toMarketMcpView(item, installed, cache))
  })
  ipcMain.handle('market:mcp-detail', async (_event, serverId: string) => {
    const { ws } = await scoped(context)
    const [detail, installed, cache] = await Promise.all([
      context.market.mcpServerDetail(serverId),
      listMarketMcpRefs([globalMcpFile(), workspaceMcpFile(ws)]),
      context.statuses.load(),
    ])
    return {
      ...toMarketMcpView(detail, installed, cache),
      disabledReason: detail.disabledReason ?? null,
      configTemplate: detail.configTemplate,
      envSchema: detail.envSchema,
      docsMd: detail.docsMd,
      versions: detail.versions,
    }
  })
  ipcMain.handle(
    'market:mcp-install',
    async (_event, serverId: string, version: number, values: Record<string, string>) => {
      const { ws } = await scoped(context)
      const detail = await context.market.mcpServerDetail(serverId)
      const versionInfo = detail.versions.find((item) => item.version === version)
      if (!versionInfo) throw new Error(t('MCP 版本不存在：{version}', { version }))
      const config = await buildMarketMcpConfig({
        id: detail.id,
        name: detail.name,
        transport: versionInfo.transport,
        configTemplate: detail.configTemplate,
        envSchema: detail.envSchema,
        version,
        values,
        secrets: context.secrets,
      })
      await saveMcpServer(globalMcpFile(), detail.name, config)
      await context.mcp.reload(ws)
      await context.statuses.check({ force: true }).catch(() => undefined)
      await reportScope(context, ws, 'global')
      return context.mcp.list(ws)
    },
  )
  ipcMain.handle('market:mcp-uninstall', async (_event, serverId: string) => {
    const { ws } = await scoped(context)
    const installed = await listMarketMcpRefs([globalMcpFile(), workspaceMcpFile(ws)])
    const mine = installed.find((ref) => ref.mcpId === serverId)
    if (mine) await saveMcpServer(globalMcpFile(), mine.name, null)
    await context.mcp.reload(ws)
    await reportScope(context, ws, 'global')
    return context.mcp.list(ws)
  })
}

function toMarketView(
  item: MarketSkill,
  installed: InstalledSkill[],
  cache: StatusCache,
): import('../../shared/ipc').MarketSkillView {
  const mine = installed
    .filter((entry) => entry.skillId === item.id)
    .sort((a, b) => compareSemver(b.version, a.version))[0]
  const entry = cache.skills[item.id]
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    tags: item.tags,
    latestVersion: item.latestVersion,
    downloadCount: item.downloadCount,
    updatedAt: item.updatedAt,
    installedVersion: mine?.version ?? null,
    updateAvailable: Boolean(mine && item.latestVersion && compareSemver(item.latestVersion, mine.version) > 0),
    ...marketStateFields(entry),
  }
}

function toMarketMcpView(
  item: {
    id: string
    name: string
    description: string
    tags: string[]
    latestVersion: number | null
    updatedAt: string
  },
  installed: import('../mcp/config').MarketMcpRef[],
  cache: StatusCache,
): import('../../shared/ipc').MarketMcpServerView {
  const mine = installed.find((ref) => ref.mcpId === item.id)
  const entry = cache.mcp[item.id]
  return {
    id: item.id,
    name: item.name,
    description: item.description,
    tags: item.tags,
    latestVersion: item.latestVersion,
    updatedAt: item.updatedAt,
    installedVersion: mine?.version ?? null,
    updateAvailable: Boolean(mine && item.latestVersion !== null && item.latestVersion > mine.version),
    ...marketStateFields(entry),
  }
}
