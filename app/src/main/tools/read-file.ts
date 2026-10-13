/** read_file：读取工作空间内文本文件，输出带行号（design 5.4.2）。 */

import { readFile, stat } from 'node:fs/promises'

import { resolveInWorkspace } from './path-guard'
import { defineTool, type ToolResult } from './types'

const MAX_BYTES = 1024 * 1024
const DEFAULT_LIMIT = 2000

interface Input {
  path: string
  offset?: number
  limit?: number
}

export const readFileTool = defineTool<Input>({
  name: 'read_file',
  description: '读取工作空间内的文本文件，返回带行号的内容。单次最多 1MB / 2000 行。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对工作空间，或工作空间内的绝对路径）' },
      offset: { type: 'integer', description: '起始行号（1 起）' },
      limit: { type: 'integer', description: '最多读取行数，默认 2000' },
    },
    required: ['path'],
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = resolveInWorkspace(ctx.workspaceRoot, input.path)
    const info = await stat(target).catch(() => null)
    if (!info) return { status: 'error', output: `文件不存在：${input.path}` }
    if (!info.isFile()) return { status: 'error', output: `不是文件：${input.path}` }
    if (info.size > MAX_BYTES) {
      return {
        status: 'error',
        output: `文件过大（${info.size} 字节 > 1MB）：请用 offset/limit 分段读取，或先在工作空间内用命令行处理。`,
      }
    }

    const buffer = await readFile(target)
    if (buffer.includes(0)) return { status: 'error', output: `二进制文件不支持读取：${input.path}` }
    const text = buffer.toString('utf8')
    const lines = text.split(/\r?\n/)
    const offset = Math.max(1, input.offset ?? 1)
    const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 5000))
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const numbered = slice.map((line, index) => `${String(offset + index).padStart(5, ' ')} | ${line}`).join('\n')
    const note = offset - 1 + slice.length < lines.length ? `\n[...共 ${lines.length} 行，已显示到第 ${offset - 1 + slice.length} 行]` : ''
    return { status: 'ok', output: numbered + note, metadata: { bytes: buffer.length } }
  },
})
