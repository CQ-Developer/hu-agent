/** 工作空间扫描与清单摘要（design 5.11.1 / 5.11.4）。
 *
 * 排除：`.hu/sync`、`.hu/logs`、`.hu/backups`、`node_modules`、`.git`、`dist`、`.venv`，
 * 以及 `<ws>/.hu/workspace.json` 中的 `syncExclude`。
 * 清单摘要 = sha256(排序后的 `相对路径\0大小\n`)，用于冲突检测（服务端不可逆推内容）。
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { t } from '../i18n'

export interface ScannedFile {
  path: string
  size: number
  mtimeMs: number
}

export interface ScanResult {
  files: ScannedFile[]
  totalBytes: number
  manifestDigest: string
}

const DEFAULT_EXCLUDES = [
  '.hu/sync',
  '.hu/logs',
  '.hu/backups',
  'node_modules',
  '.git',
  'dist',
  '.venv',
]

/** 快照中始终保留在本地、不被覆盖/删除的目录（同步元数据与审计）。 */
export const LOCAL_ONLY_DIRS = ['.hu/sync', '.hu/logs', '.hu/backups']

export interface ScanOptions {
  /** 额外排除规则（相对路径前缀或目录名） */
  excludes?: string[]
  includeSessions?: boolean
  maxFiles?: number
}

export async function readSyncExcludes(root: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(root, '.hu', 'workspace.json'), 'utf8')) as {
      syncExclude?: unknown
    }
    return Array.isArray(parsed.syncExclude) ? parsed.syncExclude.map((item) => String(item)) : []
  } catch {
    return []
  }
}

export async function scanWorkspace(root: string, options: ScanOptions = {}): Promise<ScanResult> {
  const excludes = [...DEFAULT_EXCLUDES, ...(options.excludes ?? [])]
  if (options.includeSessions === false) excludes.push('.hu/sessions')
  const files: ScannedFile[] = []

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(dir, entry.name)
      const relativePath = relative(root, absolute).split(sep).join('/')
      if (isExcluded(relativePath, entry.name, excludes)) continue
      if (entry.isSymbolicLink()) continue // 符号链接不纳入快照，避免逃逸与循环
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(absolute)
      files.push({ path: relativePath, size: info.size, mtimeMs: info.mtimeMs })
      if (options.maxFiles !== undefined && files.length > options.maxFiles) {
        throw new Error(t('文件数超过上限（{maxFiles}）', { maxFiles: options.maxFiles }))
      }
    }
  }

  await walk(root)
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
  return { files, totalBytes, manifestDigest: manifestDigestOf(files) }
}

function manifestDigestOf(files: ScannedFile[]): string {
  const hasher = createHash('sha256')
  for (const file of files) hasher.update(`${file.path}\0${file.size}\n`)
  return `sha256:${hasher.digest('hex')}`
}

export function isExcluded(relativePath: string, name: string, excludes: string[]): boolean {
  return excludes.some((pattern) => {
    const normalized = pattern.replace(/^\.\//, '').replace(/\/+$/, '')
    if (normalized.length === 0) return false
    if (normalized.includes('/')) {
      return relativePath === normalized || relativePath.startsWith(`${normalized}/`)
    }
    return name === normalized
  })
}

/** 与上次同步清单做文件级差异（用于冲突导出与本地副本备份）。 */
export interface ManifestEntry {
  size: number
  mtimeMs: number
}

export interface ManifestDiff {
  added: string[]
  modified: string[]
  removed: string[]
}

export function diffManifests(
  previous: Record<string, ManifestEntry> | undefined,
  current: ScannedFile[],
): ManifestDiff {
  const before = previous ?? {}
  const after = new Map(current.map((file) => [file.path, file]))
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  for (const [path, file] of after) {
    const previousEntry = before[path]
    if (!previousEntry) added.push(path)
    else if (previousEntry.size !== file.size || Math.abs(previousEntry.mtimeMs - file.mtimeMs) > 1) {
      modified.push(path)
    }
  }
  for (const path of Object.keys(before)) {
    if (!after.has(path)) removed.push(path)
  }
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() }
}
