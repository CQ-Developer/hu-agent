/**
 * pi 原生工具测试（R2 第一块）。
 *
 * 1. 直调 `execute`：行号、offset/limit、超大文件与二进制拒绝、文件不存在——语义与旧实现一致；
 * 2. 路径越界被 `path-guard` 拒绝（工作空间边界是硬约束，不由模型决定）；
 * 3. **通过真实 pi Agent 调用一次**：证明原生工具能直接交给 pi 使用，无需任何适配层。
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from 'vitest'

import { ToolFailure, createReadFileTool } from '../src/main/tools/native/read_file'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'huagent-native-tool-'))
}

describe('pi 原生工具：read_file', () => {
  it('读取带行号，支持 offset/limit 并提示总行数', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), ['第一行', '第二行', '第三行'].join('\n'), 'utf-8')
    const tool = createReadFileTool({ workspaceRoot: root })

    const all = await tool.execute('c1', { path: 'a.txt' }, undefined as never, undefined)
    expect((all.content[0] as { text: string }).text).toBe('    1 | 第一行\n    2 | 第二行\n    3 | 第三行')

    const slice = await tool.execute('c2', { path: 'a.txt', offset: 2, limit: 1 }, undefined as never, undefined)
    expect((slice.content[0] as { text: string }).text).toBe('    2 | 第二行\n[...共 3 行，已显示到第 2 行]')
    expect(slice.details).toMatchObject({ lines: 3, shown: 1 })
  })

  it('不存在 / 目录 / 二进制 / 超大文件都抛错（pi 约定：失败即抛）', async () => {
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
