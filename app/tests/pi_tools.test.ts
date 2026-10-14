/**
 * pi 原生工具测试（R2）：read_file / write_file / edit_file。
 *
 * 覆盖三件事：
 * 1. 直调 `execute` 的语义与旧实现一致（行号、offset/limit、覆盖保护、唯一匹配、CRLF 保留、备份）；
 * 2. 失败一律抛错（pi 约定），路径越界由 path-guard 硬拒绝（工作空间边界不由模型决定）；
 * 3. **通过真实 pi Agent 调用**：原生工具可直接交给 pi 使用，中间无需任何适配层。
 *
 * 注：CRLF/LF 用 String.fromCharCode 构造，源码里不出现反斜杠转义
 * （上一批就是因为转义被吃一层导致测试文件写坏）。
 */

import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from 'vitest'

import { createEditFileTool } from '../src/main/tools/native/edit_file'
import { createReadFileTool } from '../src/main/tools/native/read_file'
import { ToolFailure } from '../src/main/tools/native/tool'
import { createWriteFileTool } from '../src/main/tools/native/write_file'

const CRLF = String.fromCharCode(13, 10)
const LF = String.fromCharCode(10)

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'huagent-native-tool-'))
}

describe('read_file', () => {
  it('读取带行号，支持 offset/limit 并提示总行数', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), ['第一行', '第二行', '第三行'].join(LF), 'utf-8')
    const tool = createReadFileTool({ workspaceRoot: root })

    const all = await tool.execute('c1', { path: 'a.txt' }, undefined as never, undefined)
    expect((all.content[0] as { text: string }).text).toBe('    1 | 第一行\n    2 | 第二行\n    3 | 第三行')

    const slice = await tool.execute('c2', { path: 'a.txt', offset: 2, limit: 1 }, undefined as never, undefined)
    expect((slice.content[0] as { text: string }).text).toBe('    2 | 第二行\n[...共 3 行，已显示到第 2 行]')
    expect(slice.details).toMatchObject({ lines: 3, shown: 1 })
  })

  it('不存在 / 目录 / 二进制 / 超大文件都抛错', async () => {
    const root = await workspace()
    await writeFile(join(root, 'bin.dat'), Buffer.from([0x68, 0x00, 0x69]))
    await writeFile(join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1))
    const tool = createReadFileTool({ workspaceRoot: root })

    await expect(tool.execute('c1', { path: 'nope.txt' }, undefined as never, undefined)).rejects.toThrow(ToolFailure)
    await expect(tool.execute('c2', { path: '.' }, undefined as never, undefined)).rejects.toThrow(/不是文件/)
    await expect(tool.execute('c3', { path: 'bin.dat' }, undefined as never, undefined)).rejects.toThrow(/二进制/)
    await expect(tool.execute('c4', { path: 'big.txt' }, undefined as never, undefined)).rejects.toThrow(/文件过大/)
  })

  it('工作空间越界一律拒绝', async () => {
    const root = await workspace()
    const tool = createReadFileTool({ workspaceRoot: root })
    await expect(tool.execute('c1', { path: '../secret.txt' }, undefined as never, undefined)).rejects.toThrow()
    await expect(tool.execute('c2', { path: 'C:/Windows/win.ini' }, undefined as never, undefined)).rejects.toThrow()
  })

  it('通过真实 pi Agent 调用：原生工具无需适配层', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'hello', 'utf-8')

    const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux' }] })
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'a.txt' })]),
      fauxAssistantMessage('读到了 hello'),
    ])

    const agent = new Agent({
      initialState: {
        systemPrompt: '测试',
        model: models.getModel('faux', 'faux-1')!,
        tools: [createReadFileTool({ workspaceRoot: root })],
      },
      streamFn: models.streamSimple.bind(models),
    })

    await agent.prompt('读取 a.txt')

    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult') as {
      content?: Array<{ text?: string }>
    }
    expect(toolResult?.content?.[0]?.text).toContain('1 | hello')
  })
})

describe('write_file', () => {
  it('自动创建父目录；已存在时必须显式 overwrite', async () => {
    const root = await workspace()
    const tool = createWriteFileTool({ workspaceRoot: root })

    const created = await tool.execute('c1', { path: 'nested/a.txt', content: 'hi' }, undefined as never, undefined)
    expect((created.content[0] as { text: string }).text).toContain('已写入 nested/a.txt')
    expect(await readFile(join(root, 'nested', 'a.txt'), 'utf-8')).toBe('hi')

    await expect(
      tool.execute('c2', { path: 'nested/a.txt', content: 'again' }, undefined as never, undefined),
    ).rejects.toThrow(/已存在/)

    const overwritten = await tool.execute(
      'c3',
      { path: 'nested/a.txt', content: 'again', overwrite: true },
      undefined as never,
      undefined,
    )
    expect((overwritten.content[0] as { text: string }).text).toContain('5 字节')
    expect(await readFile(join(root, 'nested', 'a.txt'), 'utf-8')).toBe('again')
  })

  it('越界写入被拒绝（路径守卫先于文件系统）', async () => {
    const root = await workspace()
    const tool = createWriteFileTool({ workspaceRoot: root })
    await expect(tool.execute('c1', { path: '../out.txt', content: 'x' }, undefined as never, undefined)).rejects.toThrow()
  })
})

describe('edit_file', () => {
  it('精确替换并保留 CRLF 换行风格', async () => {
    const root = await workspace()
    const write = createWriteFileTool({ workspaceRoot: root })
    const edit = createEditFileTool({ workspaceRoot: root })

    await write.execute('c0', { path: 'b.txt', content: ['a', 'b', 'c', ''].join(CRLF) }, undefined as never, undefined)
    const done = await edit.execute(
      'c1',
      { path: 'b.txt', old_text: ['b', ''].join(LF), new_text: ['B', ''].join(LF) },
      undefined as never,
      undefined,
    )
    expect((done.content[0] as { text: string }).text).toContain('替换 1 处')
    expect(await readFile(join(root, 'b.txt'), 'utf-8')).toBe(['a', 'B', 'c', ''].join(CRLF))
  })

  it('多匹配时报出行号；replace_all 才全部替换', async () => {
    const root = await workspace()
    const write = createWriteFileTool({ workspaceRoot: root })
    const edit = createEditFileTool({ workspaceRoot: root })

    await write.execute('c0', { path: 'c.txt', content: ['x', 'x', ''].join(LF) }, undefined as never, undefined)
    await expect(
      edit.execute('c1', { path: 'c.txt', old_text: 'x', new_text: 'y' }, undefined as never, undefined),
    ).rejects.toThrow(/匹配到 2 处（行：1, 2）/)

    const all = await edit.execute(
      'c2',
      { path: 'c.txt', old_text: 'x', new_text: 'y', replace_all: true },
      undefined as never,
      undefined,
    )
    expect((all.content[0] as { text: string }).text).toContain('替换 2 处')
    expect(await readFile(join(root, 'c.txt'), 'utf-8')).toBe(['y', 'y', ''].join(LF))
  })

  it('写入前在 .hu/backups 留下备份；未匹配与文件不存在都抛错', async () => {
    const root = await workspace()
    const write = createWriteFileTool({ workspaceRoot: root })
    const edit = createEditFileTool({ workspaceRoot: root })

    await write.execute('c0', { path: 'd.txt', content: 'old' }, undefined as never, undefined)
    await edit.execute('c1', { path: 'd.txt', old_text: 'old', new_text: 'new' }, undefined as never, undefined)

    const backups = await readdir(join(root, '.hu', 'backups'))
    expect(backups.some((name) => name.startsWith('d.txt.') && name.endsWith('.bak'))).toBe(true)

    await expect(
      edit.execute('c2', { path: 'd.txt', old_text: 'nope', new_text: 'x' }, undefined as never, undefined),
    ).rejects.toThrow(/未找到匹配文本/)
    await expect(
      edit.execute('c3', { path: 'missing.txt', old_text: 'a', new_text: 'b' }, undefined as never, undefined),
    ).rejects.toThrow(/文件不存在/)
  })
})
