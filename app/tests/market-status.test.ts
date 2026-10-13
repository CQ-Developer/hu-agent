/** 资源状态同步单测（design 5.12）：缓存 TTL、硬停用判定、审计回调。 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MarketClient, StatusCheckResult } from '../src/main/market/client'
import type { InstalledSkill, SkillInstaller } from '../src/main/market/installer'
import { ResourceStatusService, isHardDisabled } from '../src/main/market/status'

class FakeMarket {
  calls = 0
  result: StatusCheckResult[] = []

  async checkStatus(): Promise<StatusCheckResult[]> {
    this.calls += 1
    return this.result
  }
}

class FakeInstaller {
  constructor(private readonly installed: InstalledSkill[]) {}
  async list(): Promise<InstalledSkill[]> {
    return this.installed
  }
}

function installed(name: string, version: string, skillId = 'skill-1'): InstalledSkill {
  return {
    skillId,
    teamId: 'team-1',
    name,
    version,
    digest: `sha256:${'a'.repeat(64)}`,
    installedAt: new Date().toISOString(),
    source: 'market',
  }
}

describe('ResourceStatusService', () => {
  let dir: string
  let cacheFile: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-status-'))
    cacheFile = join(dir, 'resource-status.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('isHardDisabled 只把 disabled/revoked/not_found 视为硬停用', () => {
    expect(isHardDisabled('disabled')).toBe(true)
    expect(isHardDisabled('revoked')).toBe(true)
    expect(isHardDisabled('not_found')).toBe(true)
    expect(isHardDisabled('delisted')).toBe(false)
    expect(isHardDisabled('active')).toBe(false)
    expect(isHardDisabled(undefined)).toBe(false)
  })

  it('检查后写入缓存并落到磁盘，15 分钟内非强制检查跳过', async () => {
    const market = new FakeMarket()
    market.result = [
      {
        type: 'skill',
        refId: 'skill-1',
        version: '1.0.0',
        status: 'active',
        reason: null,
        replacementVersion: null,
        revision: 12,
      },
    ]
    const service = new ResourceStatusService(
      market as unknown as MarketClient,
      new FakeInstaller([installed('demo-skill', '1.0.0')]) as unknown as SkillInstaller,
      cacheFile,
    )

    const first = await service.check()
    expect(first.checked).toBe(1)
    expect(service.statusForSkill('skill-1')?.status).toBe('active')

    const second = await service.check()
    expect(second.skipped).toBe(true)
    expect(market.calls).toBe(1)

    const forced = await service.check({ force: true })
    expect(forced.skipped).toBe(false)
    expect(market.calls).toBe(2)

    const persisted = JSON.parse(await readFile(cacheFile, 'utf8')) as { skills: Record<string, unknown> }
    expect(persisted.skills['skill-1']).toBeDefined()

    // 重新加载（模拟重启）仍能读到缓存
    const reloaded = new ResourceStatusService(
      market as unknown as MarketClient,
      new FakeInstaller([installed('demo-skill', '1.0.0')]) as unknown as SkillInstaller,
      cacheFile,
    )
    await reloaded.load()
    expect(reloaded.statusForSkill('skill-1')?.status).toBe('active')
  })

  it('按 Skill 取最新已安装版本去查询，并对硬停用触发审计回调', async () => {
    const market = new FakeMarket()
    market.result = [
      {
        type: 'skill',
        refId: 'skill-1',
        version: '2.0.0',
        status: 'disabled',
        reason: '存在安全问题',
        replacementVersion: null,
        revision: 20,
      },
    ]
    const events: string[] = []
    const service = new ResourceStatusService(
      market as unknown as MarketClient,
      new FakeInstaller([installed('demo-skill', '1.0.0'), installed('demo-skill', '2.0.0')]) as unknown as SkillInstaller,
      cacheFile,
      { onHardDisabled: async (entry) => events.push(`${entry.skillId}:${entry.status}`) },
    )

    const result = await service.check({ force: true })
    expect(result.checked).toBe(1)
    expect(service.statusForSkill('skill-1')).toMatchObject({ status: 'disabled', reason: '存在安全问题' })
    expect(events).toEqual(['skill-1:disabled'])
  })

  it('没有已安装资源时不请求；检查失败时返回错误而不破坏缓存', async () => {
    const market = new FakeMarket()
    const empty = new ResourceStatusService(
      market as unknown as MarketClient,
      new FakeInstaller([]) as unknown as SkillInstaller,
      cacheFile,
    )
    expect(await empty.check({ force: true })).toEqual({ checked: 0, skipped: false })

    const failing = new FakeMarket()
    failing.checkStatus = async () => {
      throw new Error('服务端不可达')
    }
    const service = new ResourceStatusService(
      failing as unknown as MarketClient,
      new FakeInstaller([installed('demo-skill', '1.0.0')]) as unknown as SkillInstaller,
      cacheFile,
    )
    const result = await service.check({ force: true })
    expect(result.checked).toBe(0)
    expect(result.error).toContain('服务端不可达')
    expect(service.statusForSkill('skill-1')).toBeUndefined()
  })
})
