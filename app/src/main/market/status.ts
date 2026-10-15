/** 资源状态同步（design 5.12）：缓存服务端状态，硬停用参与「意图 ∧ 状态」判定。
 *
 * 检查时机：启动后延迟 30s、每 6 小时、打开市场页/启用前强制检查（本地缓存 15 分钟内不重复请求）。
 * 状态为 disabled / revoked / not_found 时客户端硬停用（移出系统提示、断开 MCP），恢复后按原意图恢复。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { globalDir } from '../config/paths'
import { compareSemver } from '../skills/parser'
import type { MarketClient, ResourceState, StatusCheckItem, StatusCheckResult } from './client'
import type { SkillInstaller } from './installer'

export type StatusEntry = {
  status: ResourceState
  reason?: string
  replacementVersion?: string
  revision?: number
  checkedAt: string
}

export interface StatusCache {
  skills: Record<string, StatusEntry>
  mcp: Record<string, StatusEntry>
  lastCheckAt?: string
}

const HARD_DISABLED_STATES: readonly ResourceState[] = ['disabled', 'revoked', 'not_found']

export function isHardDisabled(status: ResourceState | undefined): boolean {
  return status !== undefined && HARD_DISABLED_STATES.includes(status)
}

export interface StatusServiceOptions {
  staleMs?: number
  intervalMs?: number
  initialDelayMs?: number
  /** 市场安装的 MCP 资源（读取本地 mcp.json 的 source.mcpId）：参与同一次状态检查 */
  listMarketMcp?: () => Promise<MarketMcpRef[]>
  /** 状态进入硬停用时的本地审计回调 */
  onHardDisabled?: (entry: {
    resourceType: 'skill' | 'mcp'
    refId: string
    name?: string
    status: ResourceState
    reason?: string
  }) => Promise<void>
}

/** 本地 mcp.json 中记录的市场来源（install 时写入 source）。 */
export interface MarketMcpRef {
  mcpId: string
  name: string
  version: number
}

export class ResourceStatusService {
  private cache: StatusCache = { skills: {}, mcp: {} }
  private loaded = false
  private intervalTimer?: NodeJS.Timeout
  private initialTimer?: NodeJS.Timeout
  private readonly staleMs: number
  private readonly intervalMs: number
  private readonly initialDelayMs: number

  constructor(
    private readonly market: MarketClient,
    private readonly installer: SkillInstaller,
    private readonly cacheFile: string = join(globalDir(), 'resource-status.json'),
    private readonly options: StatusServiceOptions = {},
  ) {
    this.staleMs = options.staleMs ?? 15 * 60_000
    this.intervalMs = options.intervalMs ?? 6 * 3600_000
    this.initialDelayMs = options.initialDelayMs ?? 30_000
  }

  async load(): Promise<StatusCache> {
    if (this.loaded) return this.cache
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8')) as StatusCache
      this.cache = { skills: parsed.skills ?? {}, mcp: parsed.mcp ?? {}, lastCheckAt: parsed.lastCheckAt }
    } catch {
      this.cache = { skills: {}, mcp: {} }
    }
    this.loaded = true
    return this.cache
  }

  /** 已缓存的资源状态（调用前请先 load）。 */
  statusForSkill(skillId: string): StatusEntry | undefined {
    return this.cache.skills[skillId]
  }

  statusForMcp(mcpId: string): StatusEntry | undefined {
    return this.cache.mcp[mcpId]
  }

  async check(options: { force?: boolean } = {}): Promise<{ checked: number; skipped: boolean; error?: string }> {
    await this.load()
    const installed = await this.installer.list()
    const latestByName = new Map<string, { skillId: string; version: string; teamId: string }>()
    for (const item of installed) {
      const current = latestByName.get(item.name)
      if (!current || compareSemver(item.version, current.version) > 0) {
        latestByName.set(item.name, { skillId: item.skillId, version: item.version, teamId: item.teamId })
      }
    }
    const mcpRefs = (await this.options.listMarketMcp?.().catch(() => [])) ?? []
    if (latestByName.size === 0 && mcpRefs.length === 0) return { checked: 0, skipped: false }

    const lastCheck = this.cache.lastCheckAt ? Date.parse(this.cache.lastCheckAt) : 0
    if (!options.force && lastCheck > 0 && Date.now() - lastCheck < this.staleMs) {
      return { checked: 0, skipped: true }
    }

    const items: StatusCheckItem[] = [
      ...[...latestByName.values()].map((item) => ({
        type: 'skill' as const,
        refId: item.skillId,
        version: item.version,
      })),
      ...mcpRefs.map((item) => ({ type: 'mcp' as const, refId: item.mcpId, version: String(item.version) })),
    ]
    try {
      const results = await this.market.checkStatus(items)
      const checkedAt = new Date().toISOString()
      for (const result of results) {
        if (result.type === 'skill') this.cache.skills[result.refId] = toEntry(result, checkedAt)
        else if (result.type === 'mcp') this.cache.mcp[result.refId] = toEntry(result, checkedAt)
      }
      this.cache.lastCheckAt = checkedAt
      await this.persist()
      await this.auditHardDisabled(results, mcpRefs)
      return { checked: results.length, skipped: false }
    } catch (error) {
      return {
        checked: 0,
        skipped: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  start(): void {
    this.stop()
    this.initialTimer = setTimeout(() => void this.check(), this.initialDelayMs)
    this.intervalTimer = setInterval(() => void this.check(), this.intervalMs)
    this.initialTimer.unref?.()
    this.intervalTimer.unref?.()
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.initialTimer = undefined
    this.intervalTimer = undefined
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.cacheFile), { recursive: true })
    const temp = `${this.cacheFile}.tmp`
    await writeFile(temp, JSON.stringify(this.cache, null, 2), 'utf8')
    await rename(temp, this.cacheFile)
  }

  private async auditHardDisabled(results: StatusCheckResult[], mcpRefs: MarketMcpRef[]): Promise<void> {
    if (!this.options.onHardDisabled) return
    const mcpNames = new Map(mcpRefs.map((item) => [item.mcpId, item.name]))
    for (const result of results) {
      if (!isHardDisabled(result.status)) continue
      await this.options.onHardDisabled({
        resourceType: result.type === 'mcp' ? 'mcp' : 'skill',
        refId: result.refId,
        ...(result.type === 'mcp' ? { name: mcpNames.get(result.refId) } : {}),
        status: result.status,
        reason: result.reason ?? undefined,
      })
    }
  }
}

function toEntry(result: StatusCheckResult, checkedAt: string): StatusEntry {
  return {
    status: result.status,
    reason: result.reason ?? undefined,
    replacementVersion: result.replacementVersion ?? undefined,
    revision: result.revision ?? undefined,
    checkedAt,
  }
}
