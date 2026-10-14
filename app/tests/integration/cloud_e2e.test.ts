/** 云账户端到端（阶段 4 退出验收）：真实服务端 + 真实 PG。
 *
 * 前置：management 已在 HUAGENT_SERVER_URL（默认 http://127.0.0.1:8080）运行。
 * 运行：CLOUD_E2E=1 npx vitest run tests/integration/cloud-e2e.test.ts
 * 结果写入 /tmp/huagent-e2e.json，供服务端 usage_events 对账使用。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CloudClient } from '../../src/main/cloud/client'
import { UsageReporter } from '../../src/main/cloud/reporter'
import { CloudStore } from '../../src/main/cloud/store'
import type { WorkspacePaths } from '../../src/main/workspace'

const enabled = process.env.CLOUD_E2E === '1'
const serverUrl = process.env.HUAGENT_SERVER_URL ?? 'http://127.0.0.1:8080'
const PASSWORD = 'Str0ng-Passphrase-2026'

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

describe.skipIf(!enabled)('云账户端到端（真实服务端）', () => {
  it('注册 → 登录 → 本地记账入队 → 上报 → 设备登记', async () => {
    const email = `e2e-${Date.now()}@example.com`
    const dir = await mkdtemp(join(tmpdir(), 'huagent-e2e-'))
    const root = join(dir, 'workspace')
    const workspace: WorkspacePaths = {
      id: 'ws_e2e',
      name: 'e2e',
      root,
      huDir: join(root, '.hu'),
      sessionDir: join(root, '.hu', 'sessions'),
      artifactDir: join(root, '.hu', 'sessions', 'artifacts'),
      auditFile: join(root, '.hu', 'logs', 'audit.jsonl'),
      settingsFile: join(root, '.hu', 'settings.json'),
    }

    // 1. 注册（客户端 UI 走同样的接口，这里直接调公开端点）
    const register = await fetch(`${serverUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, displayName: 'E2E 用户' }),
    })
    expect(register.status).toBe(201)

    // 2. 登录（refresh token 落入密钥库，access 仅内存）
    const secrets = new FakeSecrets()
    const cloud = new CloudClient(secrets, new CloudStore(join(dir, 'cloud.json')), '0.1.0')
    const user = await cloud.login(serverUrl, email, PASSWORD)
    expect(user.email).toBe(email)
    expect(await cloud.isLoggedIn()).toBe(true)

    // 3. 本地记账入队 3 条并上报
    const reporter = new UsageReporter(cloud, '0.1.0')
    const deviceId = (await cloud.config()).deviceId
    for (let index = 0; index < 3; index += 1) {
      await reporter.enqueue(workspace, {
        sessionId: 'sess-e2e',
        provider: 'deepseek',
        model: 'deepseek-chat',
        purpose: 'primary',
        inputTokens: 1000 + index,
        outputTokens: 200 + index,
        durationMs: 1234,
        status: 'success',
      })
    }
    const flush = await reporter.flush(workspace, { force: true })
    expect(flush).toMatchObject({ sent: 3, pending: 0 })
    expect(flush.error).toBeUndefined()

    // 4. 幂等：重复上报不重复计数
    const again = await reporter.flush(workspace, { force: true })
    expect(again.sent).toBe(0)
    expect(again.pending).toBe(0)

    // 5. 设备已登记，当前设备可识别
    const devices = await cloud.devices()
    expect(devices.some((device) => device.current && device.deviceId === deviceId)).toBe(true)

    // 6. 输出对账信息（服务端 usage_events 查询使用）
    const sessionHash = await reporter.sessionHash(workspace, 'sess-e2e')
    await writeFile(
      '/tmp/huagent-e2e.json',
      JSON.stringify({ email, deviceId, sessionHash, userId: user.id }, null, 2),
      'utf8',
    )
    await rm(dir, { recursive: true, force: true })
  }, 60_000)
})
