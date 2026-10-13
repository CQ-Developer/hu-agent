/** 市场客户端端到端（阶段 5 退出验收，design 5.7.4 / 5.12）：
 *  真实服务端 + MinIO：登录 → 浏览 → 下载 → sha256 校验 → 安全解压 → 安装 → 启用 →
 *  管理员停用 → 客户端状态感知（硬停用）→ 恢复。
 *
 * 前置：服务端已运行，且已执行过 scripts/stage5-demo.ps1（存在已发布的市场资源）。
 * 运行：MARKET_E2E=1 npx vitest run tests/integration/market-e2e.test.ts
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CloudClient } from '../../src/main/cloud/client'
import { CloudStore } from '../../src/main/cloud/store'
import { MarketClient } from '../../src/main/market/client'
import { SkillInstaller } from '../../src/main/market/installer'
import { ResourceStatusService, isHardDisabled } from '../../src/main/market/status'
import { SkillManager } from '../../src/main/skills/manager'
import type { WorkspacePaths } from '../../src/main/workspace'

const enabled = process.env.MARKET_E2E === '1'
const serverUrl = process.env.HUAGENT_SERVER_URL ?? 'http://127.0.0.1:8080'
const password = process.env.HUAGENT_E2E_PASSWORD ?? 'Str0ng-Passphrase-2026'

class FakeSecrets {
  private readonly values = new Map<string, string>()
  get(key: string): string | null {
    return this.values.get(key) ?? null
  }
  has(key: string): boolean {
    return this.values.has(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}

describe.skipIf(!enabled)('市场客户端端到端（真实服务端 + MinIO）', () => {
  it('浏览 → 安装 → 启用 → 管理员停用 → 客户端硬停用 → 恢复', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huagent-market-e2e-'))
    const workspace: WorkspacePaths = {
      id: 'ws_market_e2e',
      name: 'market-e2e',
      root: join(dir, 'workspace'),
      huDir: join(dir, 'workspace', '.hu'),
      sessionDir: join(dir, 'workspace', '.hu', 'sessions'),
      artifactDir: join(dir, 'workspace', '.hu', 'sessions', 'artifacts'),
      auditFile: join(dir, 'workspace', '.hu', 'logs', 'audit.jsonl'),
      settingsFile: join(dir, 'workspace', '.hu', 'settings.json'),
    }
    const skillsRoot = join(dir, 'skills')

    try {
      // 1. 成员登录
      const memberSecrets = new FakeSecrets()
      const memberCloud = new CloudClient(memberSecrets, new CloudStore(join(dir, 'member.json')), '0.1.0')
      await memberCloud.login(serverUrl, 'member@example.com', password)
      const market = new MarketClient(memberCloud)

      // 2. 浏览市场，选最新发布的资源
      const list = await market.listSkills({ q: 'demo-skill' })
      expect(list.items.length).toBeGreaterThan(0)
      const skill = [...list.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!
      expect(skill.latestVersion).toBeTruthy()

      // 3. 详情：SKILL.md 预览与权限声明
      const detail = await market.skillDetail(skill.id)
      expect(detail.skillMd).toContain('#')
      expect(detail.versions.some((version) => version.status === 'published')).toBe(true)

      // 4. 安装（下载 → sha256 → 安全解压 → 落盘 + 索引）
      const installer = new SkillInstaller(market, skillsRoot, join(dir, 'installed.json'))
      const installed = await installer.install(skill.id, skill.latestVersion!)
      expect(installed.skill.name).toBe(skill.name)
      expect((await stat(join(skillsRoot, skill.name, skill.latestVersion!, 'SKILL.md'))).isFile()).toBe(true)
      const index = JSON.parse(await readFile(join(dir, 'installed.json'), 'utf8')) as { skills: unknown[] }
      expect(index.skills).toHaveLength(1)

      // 5. 状态同步：安装后查询为 active
      const statuses = new ResourceStatusService(market, installer, join(dir, 'resource-status.json'))
      const check1 = await statuses.check({ force: true })
      expect(check1.checked).toBe(1)
      expect(statuses.statusForSkill(skill.id)?.status).toBe('active')

      // 6. 启用（本地意图）+ 系统提示注入
      const skills = new SkillManager(skillsRoot, join(dir, 'skills.json'))
      await skills.setEnabled(workspace, skill.name, 'global')
      const section = await skills.systemPromptSection(workspace)
      expect(section).toContain(skill.name)

      // 7. 管理员（owner）停用 → 客户端硬停用
      const ownerSecrets = new FakeSecrets()
      const ownerCloud = new CloudClient(ownerSecrets, new CloudStore(join(dir, 'owner.json')), '0.1.0')
      await ownerCloud.login(serverUrl, 'owner@example.com', password)
      const reason = encodeURIComponent('端到端演练停用')
      await ownerCloud.request(`/api/v1/skills/${skill.id}:disable?reason=${reason}`, { method: 'POST' })

      const check2 = await statuses.check({ force: true })
      expect(check2.error).toBeUndefined()
      const entry = statuses.statusForSkill(skill.id)
      expect(entry?.status).toBe('disabled')
      expect(entry?.reason).toBe('端到端演练停用')
      expect(isHardDisabled(entry?.status)).toBe(true)

      // 8. 恢复：管理员重新启用 → 状态回到 active，用户意图仍然保留
      await ownerCloud.request(`/api/v1/skills/${skill.id}:enable`, { method: 'POST' })
      const check3 = await statuses.check({ force: true })
      expect(check3.error).toBeUndefined()
      expect(statuses.statusForSkill(skill.id)?.status).toBe('active')
      expect((await skills.list(workspace)).find((item) => item.name === skill.name)?.enabled).toBe(true)

      // 9. 卸载：目录与索引清理
      expect(await installer.uninstall(skill.id)).toBe(1)
      await expect(stat(join(skillsRoot, skill.name))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
