/** 云同步引擎（design 5.11）：手动同步、乐观锁冲突处理、下载恢复与本地备份。
 *
 * 状态文件：`<ws>/.hu/sync/state.json`（服务端工作空间 id、上次版本、上次清单与摘要）。
 * 冲突策略：本地上次同步后有变更 且 服务端有新版本 → 阻塞，提供三个选项（保留本地副本 / 取消 / 导出差异）。
 * 不自动覆盖，不做三方合并（v1 明确取舍）。
 */

import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'

import type { WorkspacePaths } from '../workspace'
import type { SyncConflictView, SyncStatusCode, SyncStatusView, SyncVersionView } from '../../shared/ipc'
import { extractZip } from '../market/zip'
import { LOCAL_ONLY_DIRS, diffManifests, readSyncExcludes, scanWorkspace, type ManifestEntry, type ScanResult } from './scan'
import { writeZipToFile } from './zip-write'

export interface BackendSnapshot {
  id: string
  version: number
  digest: string | null
  manifestDigest: string | null
  sizeBytes: number
  fileCount: number
  pinned: boolean
  createdAt: string
  manifest?: { path: string; size: number }[] | null
}

export interface InitPayload {
  baseVersion: number
  sizeBytes: number
  fileCount: number
  manifestDigest: string
  comment?: string
  manifest?: { path: string; size: number }[]
}

export interface SyncBackend {
  ensureWorkspace(name: string): Promise<string>
  listSnapshots(workspaceId: string): Promise<BackendSnapshot[]>
  latest(workspaceId: string, withManifest?: boolean): Promise<BackendSnapshot | null>
  init(workspaceId: string, payload: InitPayload): Promise<{ snapshotId: string; version: number; uploadUrl: string }>
  upload(uploadUrl: string, filePath: string): Promise<void>
  complete(snapshotId: string, digest: string): Promise<BackendSnapshot>
  downloadUrl(snapshotId: string): Promise<{ url: string; digest: string | null; version: number }>
  download(url: string): Promise<Buffer>
  pin(snapshotId: string): Promise<void>
  remove(snapshotId: string): Promise<void>
  quota(workspaceId: string): Promise<{ usedBytes: number; limitBytes: number }>
}

export interface SyncConflictDetails extends SyncConflictView {}

export type { SyncConflictView, SyncStatusCode, SyncStatusView, SyncVersionView }

interface SyncState {
  serverWorkspaceId?: string
  lastVersion?: number
  lastManifestDigest?: string
  lastManifest?: Record<string, ManifestEntry>
  lastSyncedAt?: string
  lastError?: string
  /** 回滚到旧版本后置为 true：视为一笔新的本地改动，下次同步作为新版本上传 */
  dirty?: boolean
  conflict?: SyncConflictView
}

/** v1 在内存中解压：超过该上限提示使用排除规则（流式解压留待 v1.x）。 */
export const APPLY_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024

const EXTRACT_LIMITS = {
  maxFiles: 50_000,
  maxTotalUncompressed: APPLY_MEMORY_LIMIT_BYTES,
  maxCompressionRatio: 2000,
  maxEntrySize: 512 * 1024 * 1024,
}

export class SyncEngine {
  constructor(
    private readonly backend: SyncBackend,
    private readonly workspace: WorkspacePaths,
    private readonly options: { includeSessions?: boolean } = {},
  ) {}

  async status(): Promise<SyncStatusView> {
    const state = await this.loadState()
    const scan = await this.scan()
    const base: SyncStatusView = {
      status: 'unlinked',
      workspaceId: state.serverWorkspaceId,
      lastVersion: state.lastVersion,
      lastSyncedAt: state.lastSyncedAt,
      lastError: state.lastError,
      localFiles: scan.files.length,
      localBytes: scan.totalBytes,
      localDigest: scan.manifestDigest,
    }
    if (state.lastError) base.status = 'error'
    if (!state.serverWorkspaceId) return base

    try {
      const [latest, quota] = await Promise.all([
        this.backend.latest(state.serverWorkspaceId),
        this.backend.quota(state.serverWorkspaceId),
      ])
      base.quota = quota
      base.remoteVersion = latest?.version
      base.remoteManifestDigest = latest?.manifestDigest ?? undefined
      const localChanged = this.hasLocalChanges(scan, state)
      const remoteChanged = (latest?.version ?? 0) !== (state.lastVersion ?? 0)
      base.status = localChanged
        ? remoteChanged
          ? 'conflict'
          : 'local-changes'
        : remoteChanged
          ? 'remote-changes'
          : 'up-to-date'
      if (base.status === 'conflict' && latest) {
        base.conflict = state.conflict ?? {
          detectedAt: new Date().toISOString(),
          remoteVersion: latest.version,
          remoteDigest: latest.digest,
          localDigest: scan.manifestDigest,
          localFiles: scan.files.length,
          diff: diffManifests(state.lastManifest, scan.files),
        }
      }
    } catch (error) {
      base.status = 'error'
      base.lastError = error instanceof Error ? error.message : String(error)
    }
    return base
  }

  /** 手动同步：拉取最新 → 上传/下载/冲突（design 5.11.5）。 */
  async syncNow(): Promise<SyncStatusView> {
    let state = await this.loadState()
    if (!state.serverWorkspaceId) {
      const workspaceId = await this.backend.ensureWorkspace(this.workspace.name)
      state = { ...state, serverWorkspaceId: workspaceId }
      await this.saveState(state)
    }
    const workspaceId = state.serverWorkspaceId!

    try {
      const scan = await this.scan()
      const latest = await this.backend.latest(workspaceId)
      const localChanged = this.hasLocalChanges(scan, state)
      const remoteChanged = (latest?.version ?? 0) !== (state.lastVersion ?? 0)

      if (!localChanged && !remoteChanged) {
        await this.saveState({ ...state, lastError: undefined })
        return this.status()
      }
      if (!localChanged && remoteChanged && latest) {
        await this.applySnapshot(latest, state, { backupAll: true })
        return this.status()
      }
      if (localChanged && !remoteChanged) {
        await this.upload(workspaceId, scan, state)
        return this.status()
      }

      // 双端都有变更：阻塞并记录冲突（design 5.11.3）
      const conflict: SyncConflictView = {
        detectedAt: new Date().toISOString(),
        remoteVersion: latest?.version ?? 0,
        remoteDigest: latest?.digest ?? null,
        localDigest: scan.manifestDigest,
        localFiles: scan.files.length,
        diff: diffManifests(state.lastManifest, scan.files),
      }
      await this.saveState({ ...state, conflict, lastError: undefined })
      return this.status()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.saveState({ ...state, lastError: message })
      return this.status()
    }
  }

  /** 处理同步冲突：保留本地副本后覆盖 / 取消 / 导出差异清单。 */
  async resolve(choice: 'keep-local' | 'cancel' | 'export-diff'): Promise<SyncStatusView> {
    const state = await this.loadState()
    const conflict = state.conflict
    if (!conflict) throw new Error('当前没有待处理的同步冲突')
    if (choice === 'cancel') return this.status()

    if (choice === 'export-diff') {
      const dir = join(this.workspace.huDir, 'sync', 'conflicts')
      await mkdir(dir, { recursive: true })
      const path = join(dir, `diff-${Date.now()}.json`)
      await writeFile(
        path,
        JSON.stringify(
          { detectedAt: conflict.detectedAt, remoteVersion: conflict.remoteVersion, diff: conflict.diff },
          null,
          2,
        ),
        'utf8',
      )
      await this.saveState({ ...state, conflict: { ...conflict, diffPath: path } })
      return this.status()
    }

    // keep-local：先把本地改动复制到冲突目录，再应用服务端版本
    if (!state.serverWorkspaceId) throw new Error('尚未关联服务端工作空间')
    const latest = await this.backend.latest(state.serverWorkspaceId)
    if (!latest) throw new Error('服务端快照不存在')
    const conflictsDir = join(this.workspace.huDir, 'sync', 'conflicts', `local-${Date.now()}`)
    await this.backupChangedFiles(conflict.diff, conflictsDir)
    await this.applySnapshot(latest, { ...state, conflict: undefined }, { backupAll: true })
    return this.status()
  }

  async versions(): Promise<SyncVersionView[]> {
    const state = await this.loadState()
    if (!state.serverWorkspaceId) return []
    const snapshots = await this.backend.listSnapshots(state.serverWorkspaceId)
    const latestVersion = snapshots.length > 0 ? Math.max(...snapshots.map((item) => item.version)) : 0
    return snapshots.map((item) => ({
      id: item.id,
      version: item.version,
      sizeBytes: item.sizeBytes,
      fileCount: item.fileCount,
      pinned: item.pinned,
      createdAt: item.createdAt,
      digest: item.digest,
      latest: item.version === latestVersion,
    }))
  }

  async restore(version: number, options: { keepLocalCopy?: boolean } = {}): Promise<SyncStatusView> {
    const state = await this.loadState()
    if (!state.serverWorkspaceId) throw new Error('尚未关联服务端工作空间')
    const snapshots = await this.backend.listSnapshots(state.serverWorkspaceId)
    const snapshot = snapshots.find((item) => item.version === version)
    if (!snapshot) throw new Error(`未找到版本 ${version}`)

    const scan = await this.scan()
    if (options.keepLocalCopy && this.hasLocalChanges(scan, state)) {
      const dir = join(this.workspace.huDir, 'sync', 'conflicts', `restore-${Date.now()}`)
      await this.backupChangedFiles(diffManifests(state.lastManifest, scan.files), dir)
    }
    await this.applySnapshot(snapshot, state, { backupAll: true })

    // 回滚到旧版本后，本地内容相对「服务端最新」仍然是一笔新改动：
    // 基线指向最新版本，这样下次同步会把回滚结果作为新版本上传（而不是被覆盖）。
    const latest = await this.backend.latest(state.serverWorkspaceId)
    if (latest && latest.version !== snapshot.version) {
      const applied = await this.loadState()
      await this.saveState({
        ...applied,
        dirty: true,
        lastVersion: latest.version,
        lastManifestDigest: latest.manifestDigest ?? applied.lastManifestDigest,
      })
    }
    return this.status()
  }

  async pin(snapshotId: string): Promise<void> {
    await this.backend.pin(snapshotId)
  }

  async remove(snapshotId: string): Promise<void> {
    await this.backend.remove(snapshotId)
  }

  async clearError(): Promise<SyncStatusView> {
    const state = await this.loadState()
    await this.saveState({ ...state, lastError: undefined })
    return this.status()
  }

  // -------------------------------------------------------------------------

  private async scan(): Promise<ScanResult> {
    return scanWorkspace(this.workspace.root, {
      excludes: await readWorkspaceExcludes(this.workspace.root),
      includeSessions: this.options.includeSessions !== false,
    })
  }

  private hasLocalChanges(scan: ScanResult, state: SyncState): boolean {
    // 服务端摘要（路径+大小）是机器无关的；本地脏检查额外比对 mtime，
    // 否则同尺寸内容修改（如改一个字符）会被漏检（design 5.11.3）。
    if (state.dirty) return true
    if (state.lastManifestDigest === undefined) return scan.files.length > 0
    if (scan.manifestDigest !== state.lastManifestDigest) return true
    const previous = state.lastManifest
    if (!previous) return scan.files.length > 0
    if (scan.files.length !== Object.keys(previous).length) return true
    for (const file of scan.files) {
      const entry = previous[file.path]
      if (!entry || entry.size !== file.size || Math.abs(entry.mtimeMs - file.mtimeMs) > 1) return true
    }
    return false
  }

  private async upload(workspaceId: string, scan: ScanResult, state: SyncState): Promise<void> {
    const stagingDir = join(this.workspace.huDir, 'sync', 'staging')
    await mkdir(stagingDir, { recursive: true })
    const zipPath = join(stagingDir, `snapshot-${Date.now()}.zip`)
    try {
      const result = await writeZipToFile(
        zipPath,
        scan.files.map((file) => ({
          path: file.path,
          sourcePath: join(this.workspace.root, file.path),
          size: file.size,
          mtimeMs: file.mtimeMs,
        })),
      )
      const init = await this.backend.init(workspaceId, {
        baseVersion: state.lastVersion ?? 0,
        sizeBytes: result.sizeBytes,
        fileCount: result.fileCount,
        manifestDigest: scan.manifestDigest,
        manifest: scan.files.map((file) => ({ path: file.path, size: file.size })),
      })
      await this.backend.upload(init.uploadUrl, zipPath)
      await this.backend.complete(init.snapshotId, result.digest)
      await this.saveState({
        ...state,
        conflict: undefined,
        dirty: false,
        lastVersion: init.version,
        lastManifestDigest: scan.manifestDigest,
        lastManifest: Object.fromEntries(
          scan.files.map((file) => [file.path, { size: file.size, mtimeMs: file.mtimeMs }]),
        ),
        lastSyncedAt: new Date().toISOString(),
        lastError: undefined,
      })
    } finally {
      await rm(zipPath, { force: true })
    }
  }

  private async applySnapshot(
    snapshot: BackendSnapshot,
    state: SyncState,
    options: { backupAll: boolean },
  ): Promise<void> {
    const download = await this.backend.downloadUrl(snapshot.id)
    const data = await this.backend.download(download.url)
    const extracted = extractZip(data, EXTRACT_LIMITS)

    const before = await this.scan()
    if (options.backupAll) {
      const backupDir = join(this.workspace.huDir, 'backups', `pre-restore-${Date.now()}`)
      if (before.files.length > 0) {
        // 备份目标在工作空间内部，不能直接 cp(root, root/.hu/backups/…)：先拷到系统临时目录再移入
        const staging = await mkdtemp(join(tmpdir(), 'huagent-backup-'))
        try {
          await cp(this.workspace.root, staging, {
            recursive: true,
            filter: (source) => !isLocalOnly(relative(this.workspace.root, source)),
          })
          await mkdir(dirname(backupDir), { recursive: true })
          await rm(backupDir, { recursive: true, force: true })
          await cp(staging, backupDir, { recursive: true })
        } finally {
          await rm(staging, { recursive: true, force: true })
        }
      }
    }

    const snapshotPaths = new Set(extracted.files.map((file) => file.path))
    for (const file of extracted.files) {
      const destination = join(this.workspace.root, file.path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, file.data)
    }
    // 删除快照中不存在的本地文件（保留 .hu/sync|logs|backups）
    for (const file of before.files) {
      if (snapshotPaths.has(file.path) || isLocalOnly(file.path)) continue
      await rm(join(this.workspace.root, file.path), { force: true })
    }
    await removeEmptyDirs(this.workspace.root, this.workspace.root)

    // 重新扫描：记录应用后真实的 mtime，避免下次误判为本地改动
    const after = await this.scan()
    await this.saveState({
      ...state,
      conflict: undefined,
      dirty: false,
      lastVersion: snapshot.version,
      lastManifestDigest: after.manifestDigest,
      lastManifest: Object.fromEntries(
        after.files.map((file) => [file.path, { size: file.size, mtimeMs: file.mtimeMs }]),
      ),
      lastSyncedAt: new Date().toISOString(),
      lastError: undefined,
    })
  }

  private async backupChangedFiles(
    diff: { added: string[]; modified: string[]; removed: string[] },
    targetDir: string,
  ): Promise<void> {
    await mkdir(targetDir, { recursive: true })
    for (const path of [...diff.added, ...diff.modified]) {
      const source = join(this.workspace.root, path)
      const destination = join(targetDir, path)
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination)
    }
    await writeFile(join(targetDir, 'manifest.json'), JSON.stringify(diff, null, 2), 'utf8')
  }

  private stateFile(): string {
    return join(this.workspace.huDir, 'sync', 'state.json')
  }

  private async loadState(): Promise<SyncState> {
    try {
      return JSON.parse(await readFile(this.stateFile(), 'utf8')) as SyncState
    } catch {
      return {}
    }
  }

  private async saveState(state: SyncState): Promise<void> {
    await mkdir(join(this.workspace.huDir, 'sync'), { recursive: true })
    const temp = `${this.stateFile()}.tmp`
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
    await rename(temp, this.stateFile())
  }
}

async function readWorkspaceExcludes(root: string): Promise<string[]> {
  return readSyncExcludes(root)
}

function isLocalOnly(relativePath: string): boolean {
  const normalized = relativePath.split(sep).join('/')
  return LOCAL_ONLY_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
}

async function removeEmptyDirs(root: string, dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const absolute = join(dir, entry.name)
    if (isLocalOnly(relative(root, absolute))) continue
    await removeEmptyDirs(root, absolute)
    const remaining = await readdir(absolute)
    if (remaining.length === 0) await rm(absolute, { recursive: true, force: true })
  }
}
