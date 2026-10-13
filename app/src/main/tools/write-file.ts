/** write_file：写文件（自动创建父目录，临时文件 + rename 避免半成品）。 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { resolveInWorkspace } from './path-guard'
import { defineTool, type ToolResult } from './types'

interface Input {
  path: string
  content: string
  overwrite?: boolean
}

export const writeFileTool = defineTool<Input>({
  name: 'write_file',
  category: 'write',
  description: '写入文本文件（自动创建父目录）。目标已存在时必须显式 overwrite=true。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '文件内容' },
      overwrite: { type: 'boolean', description: '是否覆盖已存在文件（默认 false）' },
    },
    required: ['path', 'content'],
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = resolveInWorkspace(ctx.workspaceRoot, input.path)
    const exists = (await stat(target).catch(() => null))?.isFile() ?? false
    if (exists && input.overwrite !== true) {
      return { status: 'error', output: `文件已存在：${input.path}（如需覆盖请传 overwrite=true）` }
    }
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.tmp-${process.pid}`
    await writeFile(temp, input.content, 'utf8')
    await rename(temp, target)
    const bytes = Buffer.byteLength(input.content, 'utf8')
    return { status: 'ok', output: `已写入 ${input.path}（${bytes} 字节）`, metadata: { bytes } }
  },
})
