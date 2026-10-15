/** 激活快照上报（design 5.10.3）：启用/禁用资源或安装/卸载后全量覆盖当前设备状态。 */

import type { McpCatalogEntry } from '../mcp/config'
import type { SkillInfo } from '../skills/manager'
import type { ActivationItem, MarketClient } from './client'
import type { InstalledSkill } from './installer'

export interface ActivationSnapshot {
  market: MarketClient
  deviceId: string
  scope: 'global' | 'workspace'
  workspaceId?: string | null
  skills: SkillInfo[]
  installed: InstalledSkill[]
  /** 本地 MCP 配置（含市场来源） */
  mcp?: McpCatalogEntry[]
}

/** 组装某一作用域的激活项：市场来源带 refId，本地 Skill refId 为空。 */
export function buildActivationItems(
  skills: SkillInfo[],
  installed: InstalledSkill[],
  scope: 'global' | 'workspace',
): ActivationItem[] {
  const byName = new Map(installed.map((item) => [item.name, item]))
  return skills
    .filter((skill) => skill.scope === scope)
    .map((skill) => {
      const market = byName.get(skill.name)
      return {
        type: 'skill' as const,
        source: market ? ('market' as const) : ('local' as const),
        refId: market?.skillId ?? null,
        name: skill.name,
        version: skill.version ?? null,
        enabled: skill.enabled,
      }
    })
}

export async function reportActivationSnapshot(snapshot: ActivationSnapshot): Promise<number> {
  const items = [
    ...buildActivationItems(snapshot.skills, snapshot.installed, snapshot.scope),
    ...buildMcpActivationItems(snapshot.mcp ?? [], snapshot.scope, snapshot.workspaceId ?? ''),
  ]
  if (items.length === 0 && snapshot.installed.length === 0 && (snapshot.mcp?.length ?? 0) === 0) return 0
  await snapshot.market.reportActivations({
    deviceId: snapshot.deviceId,
    scope: snapshot.scope,
    workspaceId: snapshot.workspaceId ?? null,
    items,
  })
  return items.length
}

/** 组装 MCP 激活项：市场来源带 mcpId/版本，本地配置 refId 为空。 */
export function buildMcpActivationItems(
  catalog: McpCatalogEntry[],
  scope: 'global' | 'workspace',
  workspaceId: string,
): ActivationItem[] {
  return catalog.map((entry) => {
    const source = entry.config.source
    const market = source?.type === 'market' && source.mcpId ? source : null
    const enabled =
      scope === 'global'
        ? Boolean(entry.config.enabled?.global)
        : (entry.config.enabled?.workspaces ?? []).includes(workspaceId)
    return {
      type: 'mcp' as const,
      source: market ? ('market' as const) : ('local' as const),
      refId: market?.mcpId ?? null,
      name: entry.name,
      version: market?.version !== undefined ? String(market.version) : null,
      enabled,
    }
  })
}
