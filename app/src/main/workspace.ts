/** 工作空间管理（design 5.6）：默认工作空间 + 多工作空间索引 + .hu 初始化。 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { defaultWorkspaceDir } from './config/paths'
import { t } from './i18n'

export interface WorkspacePaths {
  id: string
  name: string
  root: string
  huDir: string
  sessionDir: string
  artifactDir: string
  auditFile: string
  settingsFile: string
}

interface WorkspaceRecord {
  id: string
  name: string
  root: string
  createdAt: string
}

interface WorkspaceIndex {
  workspaces: WorkspaceRecord[]
  activeId: string
}

export class WorkspaceManager {
  private index: WorkspaceIndex = { workspaces: [], activeId: '' }

  constructor(private readonly indexFile: string) {}

  async init(): Promise<WorkspacePaths> {
    await this.loadIndex()
    if (this.index.workspaces.length === 0) {
      await this.addRecord(defaultWorkspaceDir(), 'default')
    }
    if (!this.index.workspaces.some((record) => record.id === this.index.activeId)) {
      this.index.activeId = this.index.workspaces[0]?.id ?? ''
      await this.saveIndex()
    }
    return this.active()
  }

  async active(): Promise<WorkspacePaths> {
    const record = this.index.workspaces.find((item) => item.id === this.index.activeId) ?? this.index.workspaces[0]
    if (!record) throw new Error(t('工作空间未初始化'))
    return this.materialize(record)
  }

  async list(): Promise<WorkspacePaths[]> {
    return Promise.all(this.index.workspaces.map((record) => this.materialize(record)))
  }

  /** 添加（或重新激活已存在的）目录作为工作空间。 */
  async add(root: string, name?: string): Promise<WorkspacePaths> {
    const absolute = resolve(root)
    const existing = this.index.workspaces.find((record) => record.root === absolute)
    if (existing) {
      this.index.activeId = existing.id
      await this.saveIndex()
      return this.materialize(existing)
    }
    const record = await this.addRecord(absolute, name ?? basename(absolute))
    this.index.activeId = record.id
    await this.saveIndex()
    return this.materialize(record)
  }

  async setActive(id: string): Promise<WorkspacePaths> {
    if (!this.index.workspaces.some((record) => record.id === id)) {
      throw new Error(t('未知工作空间：{id}', { id }))
    }
    this.index.activeId = id
    await this.saveIndex()
    return this.active()
  }

  private async loadIndex(): Promise<void> {
    try {
      const raw = await readFile(this.indexFile, 'utf8')
      const parsed = JSON.parse(raw) as WorkspaceIndex
      if (Array.isArray(parsed.workspaces)) {
        this.index = { workspaces: parsed.workspaces, activeId: parsed.activeId ?? '' }
      }
    } catch {
      // 索引缺失/损坏：从空索引开始（init 会重建默认工作空间）
      this.index = { workspaces: [], activeId: '' }
    }
  }

  private async saveIndex(): Promise<void> {
    await mkdir(join(this.indexFile, '..'), { recursive: true })
    const temp = `${this.indexFile}.tmp`
    await writeFile(temp, JSON.stringify(this.index, null, 2), 'utf8')
    await rename(temp, this.indexFile)
  }

  private async addRecord(root: string, name: string): Promise<WorkspaceRecord> {
    // 目录里已有 .hu/workspace.json 时沿用其 id 与名称
    const metaFile = join(root, '.hu', 'workspace.json')
    let record: WorkspaceRecord | null = null
    try {
      const parsed = JSON.parse(await readFile(metaFile, 'utf8')) as Partial<WorkspaceRecord>
      if (parsed.id) {
        record = {
          id: parsed.id,
          name: parsed.name ?? name,
          root,
          createdAt: parsed.createdAt ?? new Date().toISOString(),
        }
      }
    } catch {
      // 元数据缺失/损坏：按新工作空间处理
      record = null
    }
    if (!record) {
      record = { id: `ws_${randomUUID().slice(0, 8)}`, name, root, createdAt: new Date().toISOString() }
    }
    await this.materialize(record)
    this.index.workspaces.push(record)
    await this.saveIndex()
    return record
  }

  private async materialize(record: WorkspaceRecord): Promise<WorkspacePaths> {
    const huDir = join(record.root, '.hu')
    const sessionDir = join(huDir, 'sessions')
    const artifactDir = join(sessionDir, 'artifacts')
    await mkdir(artifactDir, { recursive: true })
    await mkdir(join(huDir, 'logs'), { recursive: true })

    const metaFile = join(huDir, 'workspace.json')
    try {
      await readFile(metaFile)
    } catch {
      // 首次进入该工作空间：写入元数据
      await writeFile(metaFile, JSON.stringify(record, null, 2), 'utf8')
    }

    return {
      id: record.id,
      name: record.name,
      root: record.root,
      huDir,
      sessionDir,
      artifactDir,
      auditFile: join(huDir, 'logs', 'audit.jsonl'),
      settingsFile: join(huDir, 'settings.json'),
    }
  }
}
