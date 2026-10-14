/** 工作空间管理单测（design 5.6）。 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WorkspaceManager } from '../src/main/workspace'

describe('WorkspaceManager', () => {
  let base: string
  let indexFile: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'huagent-ws-'))
    indexFile = join(base, 'workspaces.json')
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('添加目录时初始化 .hu 结构并记录索引', async () => {
    const manager = new WorkspaceManager(indexFile)
    const dir = join(base, 'project-a')
    const ws = await manager.add(dir)

    expect(ws.root).toBe(dir)
    expect((await stat(join(dir, '.hu', 'sessions', 'artifacts'))).isDirectory()).toBe(true)
    expect((await stat(join(dir, '.hu', 'logs'))).isDirectory()).toBe(true)
    const meta = JSON.parse(await readFile(join(dir, '.hu', 'workspace.json'), 'utf8')) as { id: string }
    expect(meta.id).toBe(ws.id)
  })

  it('支持多工作空间与激活切换', async () => {
    const manager = new WorkspaceManager(indexFile)
    const a = await manager.add(join(base, 'a'))
    const b = await manager.add(join(base, 'b'))

    // add 后 b 为激活
    expect((await manager.active()).id).toBe(b.id)
    expect((await manager.list()).map((item) => item.id).sort()).toEqual([a.id, b.id].sort())

    await manager.setActive(a.id)
    expect((await manager.active()).id).toBe(a.id)

    // 新实例从索引恢复
    const reloaded = new WorkspaceManager(indexFile)
    await reloaded.init()
    expect((await reloaded.active()).id).toBe(a.id)
  })

  it('重复添加同一目录返回同一工作空间', async () => {
    const manager = new WorkspaceManager(indexFile)
    const first = await manager.add(join(base, 'same'))
    const second = await manager.add(join(base, 'same'))
    expect(second.id).toBe(first.id)
    expect(await manager.list()).toHaveLength(1)
  })
})
