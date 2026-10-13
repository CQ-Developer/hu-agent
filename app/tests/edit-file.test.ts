import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { editFileTool } from '../src/main/tools/edit-file'
import type { ArtifactStore } from '../src/main/session/artifacts'
import type { ToolContext } from '../src/main/tools/types'

function context(root: string): ToolContext {
  return {
    workspaceRoot: root,
    sessionId: 's1',
    turnId: 't1',
    signal: new AbortController().signal,
    artifacts: {} as ArtifactStore,
  }
}

describe('edit_file', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huagent-edit-'))
    await mkdir(join(root, 'src'), { recursive: true })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('唯一匹配时精确替换', async () => {
    await writeFile(join(root, 'src', 'a.ts'), 'const a = 1\nconst b = 2\n', 'utf8')
    const result = await editFileTool.run({ path: 'src/a.ts', old_text: 'const a = 1', new_text: 'const a = 42' }, context(root))
    expect(result.status).toBe('ok')
    expect(await readFile(join(root, 'src', 'a.ts'), 'utf8')).toBe('const a = 42\nconst b = 2\n')
  })

  it('多处匹配时拒绝并提示行号', async () => {
    await writeFile(join(root, 'src', 'b.ts'), 'let x = 1\nlet y = 2\nlet x = 1\n', 'utf8')
    const result = await editFileTool.run({ path: 'src/b.ts', old_text: 'let x = 1', new_text: 'let x = 9' }, context(root))
    expect(result.status).toBe('error')
    expect(result.output).toContain('2 处')
    expect(result.output).toContain('1, 3')
  })

  it('replace_all 替换全部', async () => {
    await writeFile(join(root, 'src', 'c.ts'), 'x\nx\nx\n', 'utf8')
    const result = await editFileTool.run({ path: 'src/c.ts', old_text: 'x', new_text: 'y', replace_all: true }, context(root))
    expect(result.status).toBe('ok')
    expect(await readFile(join(root, 'src', 'c.ts'), 'utf8')).toBe('y\ny\ny\n')
  })

  it('保留 CRLF 换行风格', async () => {
    await writeFile(join(root, 'src', 'd.ts'), 'a\r\nb\r\n', 'utf8')
    await editFileTool.run({ path: 'src/d.ts', old_text: 'b', new_text: 'B' }, context(root))
    expect(await readFile(join(root, 'src', 'd.ts'), 'utf8')).toBe('a\r\nB\r\n')
  })

  it('修改前生成备份', async () => {
    await writeFile(join(root, 'src', 'e.ts'), 'hello\n', 'utf8')
    await editFileTool.run({ path: 'src/e.ts', old_text: 'hello', new_text: 'world' }, context(root))

    const backups = await readdir(join(root, '.hu', 'backups'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, '.hu', 'backups', backups[0] as string), 'utf8')).toBe('hello\n')
    expect(await readFile(join(root, 'src', 'e.ts'), 'utf8')).toBe('world\n')
  })

  it('拒绝越界路径', async () => {
    await expect(editFileTool.run({ path: '../outside.txt', old_text: 'a', new_text: 'b' }, context(root))).rejects.toThrow(
      '越过工作空间',
    )
  })
})
