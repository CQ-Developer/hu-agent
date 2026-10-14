/** 市场安装器单测（design 5.7.4）：sha256 校验、安全解压、落盘与索引、卸载。 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MarketClient } from '../src/main/market/client'
import { SkillInstaller, type InstalledSkill } from '../src/main/market/installer'
import { buildZip } from './helpers/zip_writer'

function skillMd(version = '1.0.0', name = 'demo-skill'): string {
  return `---\nname: ${name}\ndescription: 演示\nversion: ${version}\n---\n\n正文\n`
}

function packageZip(version = '1.0.0', options: { zipEntryPrefix?: string } = {}): Buffer {
  const prefix = options.zipEntryPrefix ?? ''
  return buildZip([
    { path: `${prefix}SKILL.md`, data: skillMd(version) },
    { path: `${prefix}scripts/run.sh`, data: '#!/bin/sh\necho hi\n', method: 'deflate' },
  ])
}

class FakeMarket {
  constructor(
    private readonly data: Buffer,
    private readonly opts: { digestOverride?: string; version?: string; failDownload?: boolean } = {},
  ) {}

  async downloadUrl() {
    const digest = this.opts.digestOverride ?? `sha256:${createHash('sha256').update(this.data).digest('hex')}`
    return { url: 'memory://pkg', expiresIn: 300, digest, version: this.opts.version ?? '1.0.0' }
  }

  async download(): Promise<Buffer> {
    if (this.opts.failDownload) throw new Error('网络中断')
    return this.data
  }
}

describe('SkillInstaller', () => {
  let dir: string
  let skillsRoot: string
  let indexPath: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-installer-'))
    skillsRoot = join(dir, 'skills')
    indexPath = join(dir, 'installed.json')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function installer(market: FakeMarket): SkillInstaller {
    return new SkillInstaller(market as unknown as MarketClient, skillsRoot, indexPath)
  }

  it('安装：校验通过后写入目录与索引', async () => {
    const result = await installer(new FakeMarket(packageZip())).install('skill-1', '1.0.0')
    expect(result.skill).toMatchObject({ name: 'demo-skill', version: '1.0.0', skillId: 'skill-1' })
    expect(result.files).toBe(2)

    const skillFile = join(skillsRoot, 'demo-skill', '1.0.0', 'SKILL.md')
    expect((await stat(skillFile)).isFile()).toBe(true)
    expect(await readFile(skillFile, 'utf8')).toContain('version: 1.0.0')

    const index = JSON.parse(await readFile(indexPath, 'utf8')) as { skills: InstalledSkill[] }
    expect(index.skills).toHaveLength(1)
    expect(index.skills[0]?.digest).toMatch(/^sha256:/)
  })

  it('支持单一顶层目录的包', async () => {
    await installer(new FakeMarket(packageZip('1.0.0', { zipEntryPrefix: 'demo-skill/' }))).install(
      'skill-1',
      '1.0.0',
    )
    expect((await stat(join(skillsRoot, 'demo-skill', '1.0.0', 'scripts/run.sh'))).isFile()).toBe(true)
  })

  it('sha256 不一致时拒绝安装且不落盘', async () => {
    const bad = new FakeMarket(packageZip(), { digestOverride: `sha256:${'0'.repeat(64)}` })
    await expect(installer(bad).install('skill-1', '1.0.0')).rejects.toThrow(/包校验失败/)
    await expect(stat(join(skillsRoot, 'demo-skill'))).rejects.toThrow()
  })

  it('SKILL.md 版本与服务端版本不一致时拒绝', async () => {
    await expect(installer(new FakeMarket(packageZip('2.0.0'))).install('skill-1', '1.0.0')).rejects.toThrow(
      /版本不一致/,
    )
  })

  it('含 zip-slip 的包拒绝安装', async () => {
    const evil = buildZip([
      { path: 'SKILL.md', data: skillMd() },
      { path: '../evil.sh', data: 'rm -rf /' },
    ])
    await expect(installer(new FakeMarket(evil)).install('skill-1', '1.0.0')).rejects.toThrow(/上级目录/)
  })

  it('多版本并存，卸载可指定版本或全部', async () => {
    const target = installer(new FakeMarket(packageZip('1.0.0')))
    await target.install('skill-1', '1.0.0')
    await new SkillInstaller(
      new FakeMarket(packageZip('1.1.0')) as unknown as MarketClient,
      skillsRoot,
      indexPath,
    ).install('skill-1', '1.1.0')

    expect((await target.list()).map((item) => item.version).sort()).toEqual(['1.0.0', '1.1.0'])

    expect(await target.uninstall('skill-1', '1.0.0')).toBe(1)
    expect((await target.list()).map((item) => item.version)).toEqual(['1.1.0'])

    expect(await target.uninstall('skill-1')).toBe(1)
    expect(await target.list()).toEqual([])
    await expect(stat(join(skillsRoot, 'demo-skill'))).rejects.toThrow()
  })

  it('索引损坏时按空处理', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(indexPath, '{broken', 'utf8')
    expect(await installer(new FakeMarket(packageZip())).list()).toEqual([])
  })
})
