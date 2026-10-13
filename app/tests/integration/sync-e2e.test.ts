/** 云同步端到端（阶段 6 退出验收，design 5.11 / 6.6）：
 *  真实服务端 + MinIO，两台“机器”（两个临时目录）通过同一服务端工作空间同步：
 *  机器 A 上传 → 机器 B 首次接入下载 → B 修改上传 → A 拉取更新 → 冲突处理 → 恢复历史版本。
 *
 * 前置：服务端已运行（默认 http://127.0.0.1:8080）+ MinIO。
 * 运行：SYNC_E2E=1 npx vitest run tests/integration/sync-e2e.test.ts
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CloudClient } from '../../src/main/cloud/client'
import { CloudStore } from '../../src/main/cloud/store'
import { CloudSyncBackend } from '../../src/main/sync/backend'
import { SyncEngine } from '../../src/main/sync/engine'
import type { WorkspacePaths } from '../../src/main/workspace'

const enabled = process.env.SYNC_E2E === '1'
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

function workspacePaths(root: string): WorkspacePaths {
  return {
    id: 'ws_sync_e2e',
    name: 'sync-e2e',
    root,
    huDir: join(root, '.hu'),
    sessionDir: join(root, '.hu', 'sessions'),
    artifactDir: join(root, '.hu', 'sessions', 'artifacts'),
    auditFile: join(root, '.hu', 'logs', 'audit.jsonl'),
    settingsFile: join(root, '.hu', 'settings.json'),
  }
}

describe.skipIf(!enabled)('云同步端到端（真实服务端 + MinIO）', () => {
  it('两台机器上传/下载/冲突/恢复', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'huagent-sync-e2e-'))
    const workspaceName = `sync-e2e-${Date.now().toString(36)}`
    const machineA = join(dir, 'machine-a')
    const machineB = join(dir, 'machine-b')
    await mkdir(join(machineA, 'src'), { recursive: true })
    await mkdir(machineB, { recursive: true })
    await writeFile(join(machineA, 'README.md'), 'from A v1\n', 'utf8')
    await writeFile(join(machineA, 'src', 'index.ts'), 'export const a = 1\n', 'utf8')

    try {
      const cloud = new CloudClient(new FakeSecrets(), new CloudStore(join(dir, 'cloud.json')), '0.1.0')
      await cloud.login(serverUrl, 'member@example.com', password)
      const backend = new CloudSyncBackend(cloud)

      const engineA = new SyncEngine(backend, { ...workspacePaths(machineA), name: workspaceName })
      const uploaded = await engineA.syncNow()
      expect(uploaded.status).toBe('up-to-date')
      expect(uploaded.lastVersion).toBe(1)
      expect(uploaded.quota?.limitBytes).toBeGreaterThan(0)

      // 机器 B 首次接入：本地为空 → 下载 A 的快照
      const engineB = new SyncEngine(backend, { ...workspacePaths(machineB), name: workspaceName })
      const downloaded = await engineB.syncNow()
      expect(downloaded.status).toBe('up-to-date')
      expect(downloaded.lastVersion).toBe(1)
      expect(await readFile(join(machineB, 'README.md'), 'utf8')).toBe('from A v1\n')
      expect(await readFile(join(machineB, 'src', 'index.ts'), 'utf8')).toBe('export const a = 1\n')

      // B 修改后上传 v2
      await writeFile(join(machineB, 'README.md'), 'from B v2\n', 'utf8')
      const v2 = await engineB.syncNow()
      expect(v2.status).toBe('up-to-date')
      expect(v2.lastVersion).toBe(2)

      // A 拉取更新
      const aRemote = await engineA.status()
      expect(aRemote.status).toBe('remote-changes')
      const aSynced = await engineA.syncNow()
      expect(aSynced.status).toBe('up-to-date')
      expect(await readFile(join(machineA, 'README.md'), 'utf8')).toBe('from B v2\n')

      // 冲突：A、B 同时改；B 先同步（无远端新版本）→ 正常上传 v3；A 再同步 → 冲突
      await writeFile(join(machineA, 'README.md'), 'A local edit\n', 'utf8')
      await writeFile(join(machineB, 'README.md'), 'B local edit\n', 'utf8')
      const uploadedB = await engineB.syncNow()
      expect(uploadedB.status).toBe('up-to-date')

      const conflictA = await engineA.syncNow()
      expect(conflictA.status).toBe('conflict')
      expect(conflictA.conflict?.diff.modified).toContain('README.md')
      const exported = await engineA.resolve('export-diff')
      expect(exported.conflict?.diffPath).toBeTruthy()

      // 保留本地副本后覆盖：A 的本地改动存入 conflicts，内容改为 B 的版本
      const resolved = await engineA.resolve('keep-local')
      expect(resolved.status).toBe('up-to-date')
      expect(await readFile(join(machineA, 'README.md'), 'utf8')).toBe('B local edit\n')
      const conflictsRoot = join(machineA, '.hu', 'sync', 'conflicts')
      const conflictDirs = await (await import('node:fs/promises')).readdir(conflictsRoot)
      const localCopyDir = conflictDirs.find((name) => name.startsWith('local-'))!
      expect(await readFile(join(conflictsRoot, localCopyDir, 'README.md'), 'utf8')).toBe('A local edit\n')

      // 取消：制造一个真冲突（A 先上传 v4，B 有本地改动）后取消，保持冲突状态
      await writeFile(join(machineA, 'README.md'), 'A pending\n', 'utf8')
      const uploadedA = await engineA.syncNow()
      expect(uploadedA.status).toBe('up-to-date')
      await writeFile(join(machineB, 'README.md'), 'B pending\n', 'utf8')
      const conflictB = await engineB.syncNow()
      expect(conflictB.status).toBe('conflict')
      expect((await engineB.resolve('cancel')).status).toBe('conflict')
      await engineB.resolve('keep-local')

      // 回滚到 v1
      const restored = await engineA.restore(1, { keepLocalCopy: true })
      // 回滚=一笔新的本地改动（基线在服务端最新版本），避免下次同步被覆盖回去
      expect(restored.status).toBe('local-changes')
      expect(await readFile(join(machineA, 'README.md'), 'utf8')).toBe('from A v1\n')

      // 回滚提交为新版本
      const rollback = await engineA.syncNow()
      expect(rollback.status).toBe('up-to-date')
      expect(await readFile(join(machineA, 'README.md'), 'utf8')).toBe('from A v1\n')

      // 版本列表：至少有 3 个快照
      const versions = await engineB.versions()
      expect(versions.length).toBeGreaterThanOrEqual(3)
      expect(versions[0]?.latest).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
