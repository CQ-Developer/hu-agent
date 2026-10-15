/**
 * IPC 层跨域共享的视图投影与激活上报。
 *
 * 只放被两个以上域用到的纯映射/组装逻辑：Skill 视图（skills + market 两个域）、
 * 市场资源状态字段（Skill / MCP 市场共用）、激活快照上报（安装/启停后调用）。
 */

import type { SkillView } from '../../shared/ipc'
import { t } from '../i18n'
import { reportActivationSnapshot } from '../market/activations'
import type { InstalledSkill } from '../market/installer'
import { isHardDisabled, type StatusEntry } from '../market/status'
import { globalMcpFile, loadMcpFile, mergeCatalog, workspaceMcpFile } from '../mcp/config'
import { compareSemver } from '../skills/parser'
import type { WorkspacePaths } from '../workspace'
import type { AppContext } from './context'

/** Skill 列表（带市场来源与服务端状态；enabled 为实际生效值，design 5.12.2）。 */
export async function buildSkillViews(context: AppContext, ws: WorkspacePaths): Promise<SkillView[]> {
  const [skills, installed, cache] = await Promise.all([
    context.skills.list(ws),
    context.installer.list(),
    context.statuses.load(),
  ])
  const byName = latestByName(installed)
  return skills.map((skill) => {
    const market = byName.get(skill.name)
    const entry = market ? cache.skills[market.skillId] : undefined
    const isHardDisabledEntry = entry ? isHardDisabled(entry.status) : false
    return {
      ...skill,
      intentEnabled: skill.enabled,
      enabled: skill.enabled && !isHardDisabledEntry,
      market: market
        ? { skillId: market.skillId, installedVersion: market.version, updateAvailable: false }
        : undefined,
      ...marketStateFields(entry),
    }
  })
}

/** 同名 Skill 取版本最高的一条安装记录。 */
function latestByName(installed: InstalledSkill[]): Map<string, InstalledSkill> {
  const map = new Map<string, InstalledSkill>()
  for (const item of installed) {
    const current = map.get(item.name)
    if (!current || compareSemver(item.version, current.version) > 0) map.set(item.name, item)
  }
  return map
}

/** 服务端资源状态 → 市场视图的公共字段（Skill / MCP 共用）。 */
export function marketStateFields(entry: StatusEntry | undefined): {
  state: import('../../shared/ipc').MarketSkillView['state']
  stateReason: string | undefined
  replacementVersion: string | undefined
} {
  return { state: entry?.status, stateReason: entry?.reason, replacementVersion: entry?.replacementVersion }
}

/** 上报某一作用域的激活快照（登录后调用，失败不影响主流程）。 */
export async function reportScope(
  context: AppContext,
  ws: WorkspacePaths,
  scope: 'global' | 'workspace',
): Promise<void> {
  try {
    if (!(await context.cloud.isLoggedIn())) return
    const [config, skills, installed, globalServers, workspaceServers] = await Promise.all([
      context.cloud.config(),
      context.skills.list(ws),
      context.installer.list(),
      loadMcpFile(globalMcpFile()),
      loadMcpFile(workspaceMcpFile(ws)),
    ])
    await reportActivationSnapshot({
      market: context.market,
      deviceId: config.deviceId,
      scope,
      workspaceId: scope === 'workspace' ? ws.id : null,
      skills,
      installed,
      mcp: mergeCatalog(globalServers, workspaceServers),
    })
  } catch (error) {
    console.warn(t('[market] 激活上报失败：'), error)
  }
}
