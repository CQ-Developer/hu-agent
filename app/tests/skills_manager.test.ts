/** Skill 管理单测（design 5.7.2/5.7.3）：扫描、作用域优先级、启停状态、提示注入。 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SkillManager } from '../src/main/skills/manager'
import type { WorkspacePaths } from '../src/main/workspace'

function skillFile(name: string, description: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n正文\n`
}

describe('SkillManager', () => {
  let base: string
  let globalRoot: string
  let globalState: string
  let workspace: WorkspacePaths

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'huagent-skills-'))
    globalRoot = join(base, 'global-skills')
    globalState = join(base, 'global-skills.json')
    const wsRoot = join(base, 'workspace')
    workspace = {
      id: 'ws_test',
      name: 'test',
      root: wsRoot,
      huDir: join(wsRoot, '.hu'),
      sessionDir: join(wsRoot, '.hu', 'sessions'),
      artifactDir: join(wsRoot, '.hu', 'sessions', 'artifacts'),
      auditFile: join(wsRoot, '.hu', 'logs', 'audit.jsonl'),
      settingsFile: join(wsRoot, '.hu', 'settings.json'),
    }
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  async function writeSkill(root: string, dir: string, name: string, description: string, extra = ''): Promise<void> {
    const target = join(root, dir)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), skillFile(name, description, extra), 'utf8')
  }

  it('扫描全局（含版本目录）与工作空间 Skill', async () => {
    await writeSkill(globalRoot, 'pdf-report', 'pdf-report', '导出 PDF')
    await writeSkill(globalRoot, join('report', '1.2.0'), 'report', '报表', 'version: 1.2.0\n')
    await writeSkill(join(workspace.huDir, 'skills'), 'local-helper', 'local-helper', '本地工具')

    const skills = await new SkillManager(globalRoot, globalState).list(workspace)
    expect(skills.map((skill) => `${skill.name}@${skill.version ?? ''}`)).toEqual([
      'local-helper@',
      'pdf-report@',
      'report@1.2.0',
    ])
    expect(skills.find((skill) => skill.name === 'local-helper')?.scope).toBe('workspace')
  })

  it('同名时工作空间覆盖全局', async () => {
    await writeSkill(globalRoot, 'shared', 'shared', '全局版本')
    await writeSkill(join(workspace.huDir, 'skills'), 'shared', 'shared', '工作空间版本')

    const skills = await new SkillManager(globalRoot, globalState).list(workspace)
    const shared = skills.filter((skill) => skill.name === 'shared')
    expect(shared).toHaveLength(1)
    expect(shared[0]?.scope).toBe('workspace')
    expect(shared[0]?.description).toBe('工作空间版本')
  })

  it('启停状态写入各自作用域的 skills.json', async () => {
    await writeSkill(globalRoot, 'pdf-report', 'pdf-report', '导出 PDF')
    const manager = new SkillManager(globalRoot, globalState)

    await manager.setEnabled(workspace, 'pdf-report', 'global')
    let skills = await manager.list(workspace)
    expect(skills[0]?.enabled).toBe(true)
    expect(JSON.parse(await (await import('node:fs/promises')).readFile(globalState, 'utf8'))).toEqual({
      enabled: [{ name: 'pdf-report', version: undefined }],
    })

    await manager.setDisabled(workspace, 'pdf-report', 'global')
    skills = await manager.list(workspace)
    expect(skills[0]?.enabled).toBe(false)
  })

  it('同名多版本时默认激活最高 semver（design 5.7.2）', async () => {
    await writeSkill(join(workspace.huDir, 'skills'), join('multi', '1.0.0'), 'multi', '旧版本', 'version: 1.0.0\n')
    await writeSkill(join(workspace.huDir, 'skills'), join('multi', '3.0.0'), 'multi', '新版本', 'version: 3.0.0\n')
    await writeSkill(join(workspace.huDir, 'skills'), join('multi', '2.0.0'), 'multi', '中间版本', 'version: 2.0.0\n')

    const skills = await new SkillManager(globalRoot, globalState).list(workspace)
    const multi = skills.filter((skill) => skill.name === 'multi')
    expect(multi).toHaveLength(1)
    expect(multi[0]?.version).toBe('3.0.0')
    expect(multi[0]?.description).toBe('新版本')
  })

  it('系统提示只包含已启用 Skill 的元数据与路径', async () => {
    await writeSkill(globalRoot, 'pdf-report', 'pdf-report', '导出 PDF', 'when_to_use: 用户要求导出 PDF 时\n')
    await writeSkill(globalRoot, 'other', 'other', '不启用的技能')
    const manager = new SkillManager(globalRoot, globalState)
    await manager.setEnabled(workspace, 'pdf-report', 'global')

    const section = await manager.systemPromptSection(workspace)
    expect(section).toContain('pdf-report')
    expect(section).toContain('用户要求导出 PDF 时')
    expect(section).toContain(join(globalRoot, 'pdf-report', 'SKILL.md'))
    expect(section).not.toContain('other')
  })
})
