/** SKILL.md 解析单测（design 5.7.1）。 */

import { describe, expect, it } from 'vitest'

import { SkillParseError, parseSkillFile } from '../src/main/skills/parser'

const SAMPLE = `---
name: pdf-report
description: 将工作空间内的 Markdown 报表导出为 PDF
version: 1.2.0
when_to_use: 当用户要求导出 PDF、生成报表、排版打印时
requires:
  tools:
    - bash
    - read_file
  bins: [pandoc, gs]
  network: false
tags: [report, document]
min_app_version: 0.5.0
---

# 使用说明

第一步：读取模板。
`

describe('parseSkillFile', () => {
  it('解析 front matter 与正文', () => {
    const parsed = parseSkillFile(SAMPLE)
    expect(parsed.frontMatter).toMatchObject({
      name: 'pdf-report',
      description: '将工作空间内的 Markdown 报表导出为 PDF',
      version: '1.2.0',
      whenToUse: '当用户要求导出 PDF、生成报表、排版打印时',
      minAppVersion: '0.5.0',
      tags: ['report', 'document'],
    })
    expect(parsed.frontMatter.requires).toEqual({
      tools: ['bash', 'read_file'],
      bins: ['pandoc', 'gs'],
      network: false,
    })
    expect(parsed.body).toContain('# 使用说明')
    expect(parsed.body).not.toContain('---')
  })

  it('缺少 front matter 时报错', () => {
    expect(() => parseSkillFile('# 没有 front matter')).toThrow(SkillParseError)
  })

  it('缺少 name/description 时报错', () => {
    expect(() => parseSkillFile('---\nname: only-name\n---\nbody')).toThrow('description')
    expect(() => parseSkillFile('---\ndescription: only-desc\n---\nbody')).toThrow('name')
  })

  it('支持无 requires 的最小 Skill', () => {
    const parsed = parseSkillFile('---\nname: mini\ndescription: 最小示例\n---\n正文')
    expect(parsed.frontMatter.name).toBe('mini')
    expect(parsed.frontMatter.requires).toBeUndefined()
  })
})
