/** 工作空间扫描与清单摘要单测（design 5.11.1 / 5.11.4）。 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { diffManifests, isExcluded, readSyncExcludes, scanWorkspace } from '../src/main/sync/scan'

describe('isExcluded', () => {
  it('支持路径前缀与目录名两种规则', () => {
    expect(isExcluded('.hu/logs/audit.jsonl', 'audit.jsonl', ['.hu/logs'])).toBe(true)
    expect(isExcluded('node_modules/x/index.js', 'node_modules', ['node_modules'])).toBe(true)
    expect(isExcluded('src/index.ts', 'index.ts', ['node_modules', '.git'])).toBe(false)
  })
})

describe('scanWorkspace', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huagent-scan-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, 'node_modules/pkg'), { recursive: true })
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(root, '.hu', 'logs'), { recursive: true })
    await mkdir(join(root, '.hu', 'sync'), { recursive: true })
    await mkdir(join(root, '.hu', 'sessions'), { recursive: true })
    await writeFile(join(root, 'README.md'), 'hello', 'utf8')
    await writeFile(join(root, 'src', 'index.ts'), 'export {}\n', 'utf8')
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module', 'utf8')
    await writeFile(join(root, '.git', 'config'), 'git', 'utf8')
    await writeFile(join(root, '.hu', 'logs', 'audit.jsonl'), '{}', 'utf8')
    await writeFile(join(root, '.hu', 'sync', 'state.json'), '{}', 'utf8')
    await writeFile(join(root, '.hu', 'sessions', 's1.jsonl'), '{"type":"meta"}\n', 'utf8')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('按默认排除规则扫描，会话默认包含', async () => {
    const result = await scanWorkspace(root)
    expect(result.files.map((file) => file.path)).toEqual([
      '.hu/sessions/s1.jsonl',
      'README.md',
      'src/index.ts',
    ])
    expect(result.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.totalBytes).toBe(5 + 10 + 16)
  })

  it('可排除会话，并支持 workspace.json 自定义排除', async () => {
    await writeFile(
      join(root, '.hu', 'workspace.json'),
      JSON.stringify({ syncExclude: ['src'] }),
      'utf8',
    )
    expect(await readSyncExcludes(root)).toEqual(['src'])
    const result = await scanWorkspace(root, { includeSessions: false, excludes: ['src'] })
    // .hu/workspace.json 本身在同步范围内（携带同步规则）
    expect(result.files.map((file) => file.path)).toEqual(['.hu/workspace.json', 'README.md'])
  })

  it('清单摘要随文件大小变化而变化', async () => {
    const before = await scanWorkspace(root)
    await writeFile(join(root, 'README.md'), 'hello world', 'utf8')
    const after = await scanWorkspace(root)
    expect(after.manifestDigest).not.toBe(before.manifestDigest)
  })

  it('同尺寸内容修改不改摘要，但 mtime 变化可被差异检测发现', async () => {
    const before = await scanWorkspace(root)
    await new Promise((resolve) => setTimeout(resolve, 5))
    await writeFile(join(root, 'README.md'), 'HELLO', 'utf8') // 与 'hello' 同为 5 字节
    const after = await scanWorkspace(root)
    expect(after.manifestDigest).toBe(before.manifestDigest) // 摘要机器无关（仅路径+大小）
    const diff = diffManifests(
      Object.fromEntries(before.files.map((file) => [file.path, { size: file.size, mtimeMs: file.mtimeMs }])),
      after.files,
    )
    expect(diff.modified).toContain('README.md')
  })
})

describe('diffManifests', () => {
  it('输出新增/修改/删除', () => {
    const diff = diffManifests(
      { 'a.txt': { size: 1, mtimeMs: 100 }, 'b.txt': { size: 2, mtimeMs: 100 } },
      [
        { path: 'a.txt', size: 5, mtimeMs: 200 },
        { path: 'c.txt', size: 3, mtimeMs: 200 },
      ],
    )
    expect(diff).toEqual({ added: ['c.txt'], modified: ['a.txt'], removed: ['b.txt'] })
  })

  it('没有历史清单时全部视为新增', () => {
    const diff = diffManifests(undefined, [{ path: 'x', size: 1, mtimeMs: 0 }])
    expect(diff.added).toEqual(['x'])
  })
})
