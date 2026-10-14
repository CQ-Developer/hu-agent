/** 同步引擎单测（design 5.11）：上传、下载、冲突三选项、恢复与备份。
 *
 * 用内存后端模拟服务端（版本/清单/对象存储/配额），引擎侧走真实扫描与 zip 打包。
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SyncEngine, type BackendSnapshot, type InitPayload, type SyncBackend } from '../src/main/sync/engine'
import { writeZipToFile } from '../src/main/sync/zip_write'
import type { WorkspacePaths } from '../src/main/workspace'

class FakeBackend implements SyncBackend {
  workspaceId = 'ws-server-1'
  snapshots: BackendSnapshot[] = []
  objects = new Map<string, Buffer>()
  quotaValue = { usedBytes: 0, limitBytes: 10 * 1024 * 1024 * 1024 }
  failNext: string | null = null
  private seq = 0
  private pending = new Map<string, InitPayload>()

  async ensureWorkspace(): Promise<string> {
    return this.workspaceId
  }

  async listSnapshots(): Promise<BackendSnapshot[]> {
    return [...this.snapshots].sort((left, right) => right.version - left.version)
  }

  async latest(_workspaceId: string, withManifest = false): Promise<BackendSnapshot | null> {
    const snapshot = (await this.listSnapshots())[0]
    if (!snapshot) return null
    return withManifest ? snapshot : { ...snapshot, manifest: undefined }
  }

  async init(_workspaceId: string, payload: InitPayload): Promise<{ snapshotId: string; version: number; uploadUrl: string }> {
    this.seq += 1
    const snapshotId = `snap-${this.seq}`
    const version = (this.snapshots[0]?.version ?? 0) + 1
    this.pending.set(snapshotId, payload)
    return { snapshotId, version, uploadUrl: `mem-put://${snapshotId}` }
  }

  async upload(uploadUrl: string, filePath: string): Promise<void> {
    this.objects.set(uploadUrl.replace('mem-put://', ''), await readFile(filePath))
  }

  async complete(snapshotId: string, digest: string): Promise<BackendSnapshot> {
    const data = this.objects.get(snapshotId)!
    const payload = this.pending.get(snapshotId)!
    const snapshot: BackendSnapshot = {
      id: snapshotId,
      version: (this.snapshots[0]?.version ?? 0) + 1,
      digest,
      manifestDigest: payload.manifestDigest,
      sizeBytes: data.length,
      fileCount: payload.fileCount,
      pinned: false,
      createdAt: new Date().toISOString(),
      manifest: payload.manifest ?? null,
    }
    this.snapshots.unshift(snapshot)
    return snapshot
  }

  async downloadUrl(snapshotId: string): Promise<{ url: string; digest: string | null; version: number }> {
    const snapshot = this.snapshots.find((item) => item.id === snapshotId)!
    return { url: `mem-get://${snapshotId}`, digest: snapshot.digest, version: snapshot.version }
  }

  async download(url: string): Promise<Buffer> {
    const data = this.objects.get(url.replace('mem-get://', ''))
    if (!data) throw new Error('对象不存在')
    return data
  }

  async pin(snapshotId: string): Promise<void> {
    const snapshot = this.snapshots.find((item) => item.id === snapshotId)
    if (snapshot) snapshot.pinned = true
  }

  async remove(snapshotId: string): Promise<void> {
    this.snapshots = this.snapshots.filter((item) => item.id !== snapshotId)
    this.objects.delete(snapshotId)
  }

  async quota(): Promise<{ usedBytes: number; limitBytes: number }> {
    if (this.failNext === 'quota') throw new Error('服务端不可达')
    return this.quotaValue
  }

  /** 模拟另一端发布新版本（服务端已有他人上传的快照）。 */
  async publishRemote(files: Record<string, string>, dir: string): Promise<BackendSnapshot> {
    const sourceDir = join(dir, `remote-${this.seq}`)
    const sources: { path: string; sourcePath: string; size: number }[] = []
    for (const [path, content] of Object.entries(files)) {
      const sourcePath = join(sourceDir, path)
      await mkdir(join(sourcePath, '..'), { recursive: true })
      await writeFile(sourcePath, content, 'utf8')
      sources.push({ path, sourcePath, size: Buffer.byteLength(content) })
    }
    const zipPath = join(sourceDir, 'snapshot.zip')
    await writeZipToFile(zipPath, sources)

    const manifest = sources.map((source) => ({ path: source.path, size: source.size }))
    const manifestHasher = createHash('sha256')
    for (const file of [...manifest].sort((left, right) => (left.path < right.path ? -1 : 1))) {
      manifestHasher.update(`${file.path}\0${file.size}\n`)
    }
    this.seq += 1
    const snapshotId = `remote-${this.seq}`
    this.objects.set(snapshotId, await readFile(zipPath))
    const snapshot: BackendSnapshot = {
      id: snapshotId,
      version: (this.snapshots[0]?.version ?? 0) + 1,
      digest: `sha256:${createHash('sha256').update(this.objects.get(snapshotId)!).digest('hex')}`,
      manifestDigest: `sha256:${manifestHasher.digest('hex')}`,
      sizeBytes: this.objects.get(snapshotId)!.length,
      fileCount: manifest.length,
      pinned: false,
      createdAt: new Date().toISOString(),
      manifest,
    }
    this.snapshots.unshift(snapshot)
    return snapshot
  }
}

describe('SyncEngine', () => {
  let dir: string
  let root: string
  let workspace: WorkspacePaths
  let backend: FakeBackend
  let engine: SyncEngine

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-sync-'))
    root = join(dir, 'workspace')
    workspace = {
      id: 'ws_test',
      name: '演示工作空间',
      root,
      huDir: join(root, '.hu'),
      sessionDir: join(root, '.hu', 'sessions'),
      artifactDir: join(root, '.hu', 'sessions', 'artifacts'),
      auditFile: join(root, '.hu', 'logs', 'audit.jsonl'),
      settingsFile: join(root, '.hu', 'settings.json'),
    }
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'README.md'), 'v1\n', 'utf8')
    await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1\n', 'utf8')
    backend = new FakeBackend()
    engine = new SyncEngine(backend, workspace)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('首次同步上传并进入 up-to-date', async () => {
    const before = await engine.status()
    expect(before.status).toBe('unlinked')
    expect(before.localFiles).toBe(2)

    const after = await engine.syncNow()
    expect(after.status).toBe('up-to-date')
    expect(after.lastVersion).toBe(1)
    expect(after.localDigest).toBe(after.remoteManifestDigest)
    expect(backend.snapshots).toHaveLength(1)
    expect(backend.snapshots[0]?.fileCount).toBe(2)

    const versions = await engine.versions()
    expect(versions[0]).toMatchObject({ version: 1, latest: true, fileCount: 2 })
  })

  it('本地修改后再次同步生成新版本', async () => {
    await engine.syncNow()
    await writeFile(join(root, 'README.md'), 'v2 changed\n', 'utf8')

    const dirty = await engine.status()
    expect(dirty.status).toBe('local-changes')

    const synced = await engine.syncNow()
    expect(synced.status).toBe('up-to-date')
    expect(synced.lastVersion).toBe(2)
    expect(backend.snapshots).toHaveLength(2)
    expect(backend.snapshots[0]?.manifest?.find((file) => file.path === 'README.md')?.size).toBe(11)
  })

  it('服务端有新版本且本地无改动时下载覆盖并备份', async () => {
    await engine.syncNow()
    await backend.publishRemote({ 'README.md': 'remote\n', 'src/extra.ts': 'export {}\n' }, dir)

    const dirty = await engine.status()
    expect(dirty.status).toBe('remote-changes')

    const synced = await engine.syncNow()
    expect(synced.status).toBe('up-to-date')
    expect(synced.lastVersion).toBe(2)
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('remote\n')
    expect(await readFile(join(root, 'src', 'extra.ts'), 'utf8')).toBe('export {}\n')
    // 覆盖前备份到 .hu/backups/pre-restore-*
    const backups = await stat(join(root, '.hu', 'backups'))
    expect(backups.isDirectory()).toBe(true)
  })

  it('双端都有改动时阻塞为冲突，并支持三个处理选项', async () => {
    await engine.syncNow()
    await writeFile(join(root, 'README.md'), 'local edit\n', 'utf8')
    await backend.publishRemote({ 'README.md': 'remote edit\n' }, dir)

    const conflict = await engine.syncNow()
    expect(conflict.status).toBe('conflict')
    expect(conflict.conflict?.diff.modified).toContain('README.md')
    expect(conflict.conflict?.remoteVersion).toBe(2)

    // 取消：保持冲突
    expect((await engine.resolve('cancel')).status).toBe('conflict')

    // 导出差异：写入 json，冲突仍在
    const exported = await engine.resolve('export-diff')
    expect(exported.conflict?.diffPath).toBeTruthy()
    expect(JSON.parse(await readFile(exported.conflict!.diffPath!, 'utf8')).diff.modified).toContain('README.md')

    // 保留本地副本后覆盖
    const resolved = await engine.resolve('keep-local')
    expect(resolved.status).toBe('up-to-date')
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('remote edit\n')
    const conflictsRoot = join(root, '.hu', 'sync', 'conflicts')
    const dirs = await import('node:fs/promises').then((fs) => fs.readdir(conflictsRoot))
    const localCopyDir = dirs.find((name) => name.startsWith('local-'))!
    expect(await readFile(join(conflictsRoot, localCopyDir, 'README.md'), 'utf8')).toBe('local edit\n')
  })

  it('恢复到历史版本', async () => {
    await engine.syncNow()
    await writeFile(join(root, 'README.md'), 'v2\n', 'utf8')
    await engine.syncNow()
    await writeFile(join(root, 'README.md'), 'v3\n', 'utf8')
    await engine.syncNow()

    const restored = await engine.restore(1)
    // 回滚=一笔新的本地改动（基线仍在服务端最新版本），避免下次同步被覆盖回去
    expect(restored.status).toBe('local-changes')
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('v1\n')
    expect(restored.lastVersion).toBe(3)

    // 再次同步：回滚结果作为新版本 v4 上传
    const committed = await engine.syncNow()
    expect(committed.status).toBe('up-to-date')
    expect(committed.lastVersion).toBe(4)
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('v1\n')
  })

  it('服务端不可达时返回 error 并可清除', async () => {
    await engine.syncNow()
    backend.failNext = 'quota'
    const failed = await engine.status()
    expect(failed.status).toBe('error')
    expect(failed.lastError).toContain('服务端不可达')

    backend.failNext = null
    await engine.clearError()
    expect((await engine.status()).status).toBe('up-to-date')
  })

  it('保存会话目录且排除 .hu/sync', async () => {
    await mkdir(join(root, '.hu', 'sessions'), { recursive: true })
    await writeFile(join(root, '.hu', 'sessions', 's1.jsonl'), '{"type":"meta"}\n', 'utf8')
    const status = await engine.syncNow()
    expect(status.localFiles).toBe(3)
    const paths = backend.snapshots[0]?.manifest?.map((file) => file.path) ?? []
    expect(paths).toContain('.hu/sessions/s1.jsonl')
    expect(paths.some((path) => path.startsWith('.hu/sync/'))).toBe(false)
  })
})
