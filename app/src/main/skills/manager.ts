/** Skill 管理（design 5.7）：扫描全局/工作空间目录、启停状态、系统提示注入。 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { globalDir } from '../config/paths'
import type { WorkspacePaths } from '../workspace'
import { compareSemver, parseSkillFile, type SkillRequires } from './parser'

export type SkillScope = 'global' | 'workspace'

export interface SkillInfo {
  name: string
  description: string
  version?: string
  whenToUse?: string
  requires?: SkillRequires
  scope: SkillScope
  path: string
  enabled: boolean
}

interface SkillStateFile {
  enabled?: { name: string; version?: string }[]
}

const SEMVER = /^\d+\.\d+\.\d+/

export function globalSkillsDir(): string {
  return join(globalDir(), 'skills')
}

export function globalSkillsStateFile(): string {
  return join(globalDir(), 'skills.json')
}

export class SkillManager {
  constructor(
    private readonly globalSkillsRoot: string = globalSkillsDir(),
    private readonly globalStateFile: string = globalSkillsStateFile(),
  ) {}

  async list(workspace: WorkspacePaths): Promise<SkillInfo[]> {
    const workspaceRoot = join(workspace.huDir, 'skills')
    const [workspaceSkills, globalSkills] = await Promise.all([
      this.scanRoot(workspaceRoot, 'workspace'),
      this.scanRoot(this.globalSkillsRoot, 'global'),
    ])
    const workspaceEnabled = await this.loadEnabled(join(workspace.huDir, 'skills.json'))
    const globalEnabled = await this.loadEnabled(this.globalStateFile)

    const merged = new Map<string, SkillInfo>()
    for (const skill of globalSkills) {
      merged.set(skill.name, { ...skill, enabled: globalEnabled.has(keyOf(skill)) })
    }
    // 工作空间同名覆盖全局（design 5.7.2）
    for (const skill of workspaceSkills) {
      merged.set(skill.name, { ...skill, enabled: workspaceEnabled.has(keyOf(skill)) })
    }
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async setEnabled(workspace: WorkspacePaths, name: string, scope: SkillScope): Promise<void> {
    const file = scope === 'workspace' ? join(workspace.huDir, 'skills.json') : this.globalStateFile
    const skills = await this.list(workspace)
    const skill = skills.find((item) => item.name === name)
    if (!skill) throw new Error(`未找到 Skill：${name}`)
    await this.saveEnabled(file, keyOf(skill))
  }

  async setDisabled(workspace: WorkspacePaths, name: string, scope: SkillScope): Promise<void> {
    const file = scope === 'workspace' ? join(workspace.huDir, 'skills.json') : this.globalStateFile
    const skills = await this.list(workspace)
    const skill = skills.find((item) => item.name === name)
    if (!skill) throw new Error(`未找到 Skill：${name}`)
    await this.saveDisabled(file, keyOf(skill))
  }

  /** 注入系统提示的 Skill 元数据（渐进披露，design 5.7.3）。 */
  async systemPromptSection(workspace: WorkspacePaths): Promise<string> {
    const enabled = (await this.list(workspace)).filter((skill) => skill.enabled)
    if (enabled.length === 0) return ''
    const lines = enabled.map((skill) => {
      const details = [
        skill.version ? `v${skill.version}` : null,
        skill.whenToUse ? `适用：${skill.whenToUse}` : null,
        `path：${skill.path}`,
      ]
        .filter(Boolean)
        .join('；')
      return `- ${skill.name}：${skill.description}（${details}）`
    })
    return ['可用 Skill（需要时用 read_file 读取其 SKILL.md 全文再执行）：', ...lines].join('\n')
  }

  private async scanRoot(root: string, scope: SkillScope): Promise<SkillInfo[]> {
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch {
      return []
    }
    const skills: SkillInfo[] = []
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const dir = join(root, entry)
      const direct = await this.tryLoad(join(dir, 'SKILL.md'), scope)
      if (direct) {
        skills.push(direct)
        continue
      }
      // 版本化目录：<name>/<version>/SKILL.md；同作用域同名的多版本默认激活最高 semver（design 5.7.2）
      let versions: string[]
      try {
        versions = await readdir(dir)
      } catch {
        continue
      }
      const candidates: SkillInfo[] = []
      for (const version of versions) {
        if (!SEMVER.test(version)) continue
        const parsed = await this.tryLoad(join(dir, version, 'SKILL.md'), scope)
        if (parsed) candidates.push({ ...parsed, version: parsed.version ?? version })
      }
      const best = candidates.sort((a, b) => compareSemver(b.version ?? '0.0.0', a.version ?? '0.0.0'))[0]
      if (best) skills.push(best)
    }
    return skills
  }

  private async tryLoad(file: string, scope: SkillScope): Promise<SkillInfo | null> {
    try {
      const parsed = parseSkillFile(await readFile(file, 'utf8'))
      return {
        name: parsed.frontMatter.name,
        description: parsed.frontMatter.description,
        version: parsed.frontMatter.version,
        whenToUse: parsed.frontMatter.whenToUse,
        requires: parsed.frontMatter.requires,
        scope,
        path: file,
        enabled: false,
      }
    } catch {
      return null
    }
  }

  private async loadEnabled(file: string): Promise<Set<string>> {
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as SkillStateFile
      return new Set((data.enabled ?? []).map((item) => `${item.name}@${item.version ?? ''}`))
    } catch {
      return new Set()
    }
  }

  private async saveEnabled(file: string, key: string): Promise<void> {
    const current = await this.readState(file)
    if (!current.some((item) => `${item.name}@${item.version ?? ''}` === key)) {
      const [name, version] = key.split('@')
      current.push({ name: name ?? key, version: version || undefined })
    }
    await this.writeState(file, current)
  }

  private async saveDisabled(file: string, key: string): Promise<void> {
    const current = await this.readState(file)
    await this.writeState(
      file,
      current.filter((item) => `${item.name}@${item.version ?? ''}` !== key),
    )
  }

  private async readState(file: string): Promise<{ name: string; version?: string }[]> {
    try {
      const data = JSON.parse(await readFile(file, 'utf8')) as SkillStateFile
      return Array.isArray(data.enabled) ? data.enabled : []
    } catch {
      return []
    }
  }

  private async writeState(file: string, enabled: { name: string; version?: string }[]): Promise<void> {
    await mkdir(join(file, '..'), { recursive: true })
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify({ enabled }, null, 2), 'utf8')
    await rename(temp, file)
  }
}

function keyOf(skill: SkillInfo): string {
  return `${skill.name}@${skill.version ?? ''}`
}
