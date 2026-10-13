/** 市场资源安装器（design 5.7.4 / 5.7.5）：
 *  预签名下载 → sha256 校验 → 安全解压 → 写入 ~/.hu-agent/skills/<name>/<version>/ → 记录 installed.json。
 *  安装/更新只落盘，不自动启用（启用由用户在 Skill 配置或市场页显式操作）。
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { globalDir } from '../config/paths'
import { SkillParseError, parseSkillFile } from '../skills/parser'
import type { MarketClient } from './client'
import { extractZip, type ZipLimits } from './zip'

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxFiles: 500,
  maxTotalUncompressed: 100 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxEntrySize: 50 * 1024 * 1024,
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/

export interface InstalledSkill {
  skillId: string
  teamId: string
  name: string
  version: string
  digest: string
  installedAt: string
  source: 'market'
}

interface InstalledFile {
  skills: InstalledSkill[]
}

export interface InstallResult {
  skill: InstalledSkill
  files: number
}

export class SkillInstaller {
  constructor(
    private readonly market: MarketClient,
    private readonly skillsRoot: string = join(globalDir(), 'skills'),
    private readonly indexPath: string = join(globalDir(), 'installed.json'),
    private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  ) {}

  async list(): Promise<InstalledSkill[]> {
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8')) as InstalledFile
      return Array.isArray(parsed.skills) ? parsed.skills : []
    } catch {
      return []
    }
  }

  async install(skillId: string, version: string): Promise<InstallResult> {
    const info = await this.market.downloadUrl(skillId, version)
    const data = await this.market.download(info.url)
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`
    if (info.digest && digest !== info.digest) {
      throw new Error(`包校验失败：期望 ${info.digest}，实际 ${digest}`)
    }

    const extracted = extractZip(data, this.limits)
    const skillMdPath = locateSkillMd(extracted.entries.map((entry) => entry.path))
    const prefix = skillMdPath === 'SKILL.md' ? '' : skillMdPath.slice(0, -'SKILL.md'.length)
    const skillMd = extracted.files.find((file) => file.path === skillMdPath)
    if (!skillMd) throw new Error('包内缺少 SKILL.md')

    let name: string
    let declaredVersion: string | undefined
    try {
      const parsed = parseSkillFile(skillMd.data.toString('utf8'))
      name = parsed.frontMatter.name
      declaredVersion = parsed.frontMatter.version
    } catch (error) {
      throw new Error(`SKILL.md 解析失败：${error instanceof SkillParseError ? error.message : String(error)}`)
    }
    if (!NAME_PATTERN.test(name)) throw new Error(`Skill 名称不合法：${name}`)
    if (declaredVersion && declaredVersion !== version) {
      throw new Error(`版本不一致：服务端 ${version}，SKILL.md ${declaredVersion}`)
    }

    const targetDir = join(this.skillsRoot, name, version)
    const tempDir = `${targetDir}.tmp-${Date.now().toString(36)}`
    await rm(tempDir, { recursive: true, force: true })
    await mkdir(tempDir, { recursive: true })
    try {
      for (const file of extracted.files) {
        const relative = prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path
        const destination = join(tempDir, relative)
        if (!destination.startsWith(tempDir)) throw new Error(`非法路径：${file.path}`)
        await mkdir(dirname(destination), { recursive: true })
        await writeFile(destination, file.data)
      }
      await rm(targetDir, { recursive: true, force: true })
      await mkdir(dirname(targetDir), { recursive: true })
      await rename(tempDir, targetDir)
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true })
      throw error
    }

    const installed: InstalledSkill = {
      skillId,
      teamId: '',
      name,
      version,
      digest,
      installedAt: new Date().toISOString(),
      source: 'market',
    }
    const skills = await this.list()
    const next = skills.filter((item) => !(item.skillId === skillId && item.version === version))
    next.push(installed)
    await this.writeIndex(next)
    return { skill: installed, files: extracted.files.length }
  }

  /** 卸载：删除目录与索引；version 省略时删除该 Skill 的全部版本。 */
  async uninstall(skillId: string, version?: string): Promise<number> {
    const skills = await this.list()
    const removed = skills.filter(
      (item) => item.skillId === skillId && (version === undefined || item.version === version),
    )
    for (const item of removed) {
      await rm(join(this.skillsRoot, item.name, item.version), { recursive: true, force: true })
      await this.removeEmptyParent(join(this.skillsRoot, item.name))
    }
    await this.writeIndex(
      skills.filter((item) => !(item.skillId === skillId && (version === undefined || item.version === version))),
    )
    return removed.length
  }

  private async writeIndex(skills: InstalledSkill[]): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true })
    const temp = `${this.indexPath}.tmp`
    await writeFile(temp, JSON.stringify({ skills } satisfies InstalledFile, null, 2), 'utf8')
    await rename(temp, this.indexPath)
  }

  private async removeEmptyParent(dir: string): Promise<void> {
    try {
      const { readdir } = await import('node:fs/promises')
      if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true, force: true })
    } catch {
      // 目录不存在或非空：忽略
    }
  }
}

function locateSkillMd(paths: string[]): string {
  if (paths.includes('SKILL.md')) return 'SKILL.md'
  const candidates = paths.filter((path) => path.endsWith('/SKILL.md'))
  const topLevels = new Set(paths.map((path) => path.split('/')[0]))
  if (candidates.length === 1 && topLevels.size === 1) return candidates[0]!
  throw new Error('包内需在根目录或单一顶层目录下包含 SKILL.md')
}
