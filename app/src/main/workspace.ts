/** 工作空间（阶段 1 为隐式默认工作空间；阶段 2 支持选择目录 + 权限引擎）。 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { defaultWorkspaceDir } from './config/paths'

export interface WorkspacePaths {
  id: string
  root: string
  huDir: string
  sessionDir: string
  artifactDir: string
}

interface WorkspaceFile {
  id: string
  name: string
  createdAt: string
}

export async function ensureDefaultWorkspace(): Promise<WorkspacePaths> {
  const root = defaultWorkspaceDir()
  const huDir = join(root, '.hu')
  const sessionDir = join(huDir, 'sessions')
  const artifactDir = join(sessionDir, 'artifacts')
  await mkdir(artifactDir, { recursive: true })

  const metaFile = join(huDir, 'workspace.json')
  let meta: WorkspaceFile
  try {
    meta = JSON.parse(await readFile(metaFile, 'utf8')) as WorkspaceFile
  } catch {
    meta = { id: `ws_${Date.now().toString(36)}`, name: 'default', createdAt: new Date().toISOString() }
    await writeFile(metaFile, JSON.stringify(meta, null, 2), 'utf8')
  }

  return { id: meta.id, root, huDir, sessionDir, artifactDir }
}
