/** 统计客户端端到端（6-06/6-07 验证）：真实服务端返回的用量与激活数据。
 *
 * 前置：服务端已运行；目标账号已上报用量且已完成聚合（worker 启动时会补偿聚合）。
 * 运行：STATS_E2E=1 HUAGENT_STATS_EMAIL=stats-e2e@example.com \
 *        npx vitest run tests/integration/stats-e2e.test.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CloudClient } from '../../src/main/cloud/client'
import { CloudStore } from '../../src/main/cloud/store'
import { StatsClient } from '../../src/main/stats/client'

const enabled = process.env.STATS_E2E === '1'
const serverUrl = process.env.HUAGENT_SERVER_URL ?? 'http://127.0.0.1:8080'
const email = process.env.HUAGENT_STATS_EMAIL ?? 'stats-e2e@example.com'
const password = process.env.HUAGENT_E2E_PASSWORD ?? 'Str0ng-Passphrase-2026'
const model = process.env.HUAGENT_STATS_MODEL ?? 'stats-e2e-model'

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

describe.skipIf(!enabled)('统计客户端端到端（真实服务端）', () => {
  it('个人用量与激活明细返回可用数据', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huagent-stats-e2e-'))
    try {
      const cloud = new CloudClient(new FakeSecrets(), new CloudStore(join(dir, 'cloud.json')), '0.1.0')
      await cloud.login(serverUrl, email, password)
      const stats = new StatsClient(cloud)

      const to = new Date()
      const from = new Date(to.getTime() - 7 * 24 * 3600_000)
      const iso = (value: Date): string => value.toISOString().slice(0, 10)

      const usage = await stats.usage({ scope: 'self', from: iso(from), to: iso(to), groupBy: 'model' })
      expect(usage.totals.requests).toBeGreaterThanOrEqual(3)
      const row = usage.rows.find((item) => item.model === model)
      expect(row).toBeDefined()
      // 种子脚本每次追加 3 条，重复执行会累加，因此断言下界（精确对账由阶段 4 的 CLOUD_E2E 验证）
      expect(row?.inputTokens ?? 0).toBeGreaterThanOrEqual(3003)
      expect(row?.outputTokens ?? 0).toBeGreaterThanOrEqual(300)
      expect(row?.errors ?? 0).toBeGreaterThanOrEqual(1)
      expect(usage.currency).toBe('USD')

      const byDay = await stats.usage({ scope: 'self', from: iso(from), to: iso(to), groupBy: 'day' })
      expect(byDay.rows.length).toBeGreaterThan(0)

      const activations = await stats.activations({ scope: 'self' })
      expect(Array.isArray(activations)).toBe(true)

      // 非管理员访问团队范围应被拒绝
      await expect(stats.usage({ scope: 'global', from: iso(from), to: iso(to), groupBy: 'org' })).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
