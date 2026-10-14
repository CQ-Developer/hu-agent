/**
 * pi 原生工具（R2）：`read_file`。
 *
 * 与旧实现的差别只有"形状"——按 pi 的约定写：
 * - 参数用 typebox 声明（pi 用它做校验与向模型生成 JSON Schema）；
 * - 失败**抛错**而不是把错误当内容返回（pi 会把抛出的错误变成工具错误结果）；
 * - 工具自带 `workspaceRoot`（工厂函数闭包），因为 pi 的 `execute` 不接收我们的上下文对象。
 *
 * `category` 是我们加在产品层的**字段**（权限策略需要区分 read/write/exec/interact/mcp），
 * 不是对 pi 形状的翻译：`NativeTool = AgentTool & { category }`。
 */

import { readFile, stat } from 'node:fs/promises'

import { Type } from 'typebox'

import { resolveInWorkspace } from '../path_guard'
import { ToolFailure, type NativeTool, type ToolFactoryOptions } from './tool'

export { ToolFailure, type NativeTool, type ToolFactoryOptions }

const MAX_BYTES = 1024 * 1024
const DEFAULT_LIMIT = 2000
const MAX_LIMIT = 5000

export function createReadFileTool(options: ToolFactoryOptions): NativeTool {
  return {
    name: 'read_file',
    label: '读取文件',
    category: 'read',
    description: '读取工作空间内的文本文件，返回带行号的内容。单次最多 1MB / 2000 行。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径（相对工作空间，或工作空间内的绝对路径）' }),
      offset: Type.Optional(Type.Integer({ description: '起始行号（1 起）' })),
      limit: Type.Optional(Type.Integer({ description: '最多读取行数，默认 2000' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { path: string; offset?: number; limit?: number }
      const target = resolveInWorkspace(options.workspaceRoot, input.path)

      const info = await stat(target).catch(() => null)
      if (!info) throw new ToolFailure(`文件不存在：${input.path}`)
      if (!info.isFile()) throw new ToolFailure(`不是文件：${input.path}`)
      if (info.size > MAX_BYTES) {
        throw new ToolFailure(
          `文件过大（${info.size} 字节 > 1MB）：请用 offset/limit 分段读取，或先在工作空间内用命令行处理。`,
        )
      }

      const buffer = await readFile(target)
      if (buffer.includes(0)) throw new ToolFailure(`二进制文件不支持读取：${input.path}`)

      const lines = buffer.toString('utf8').split(/\r?\n/)
      const offset = Math.max(1, input.offset ?? 1)
      const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice.map((line, index) => `${String(offset + index).padStart(5, ' ')} | ${line}`).join('\n')
      const reached = offset - 1 + slice.length
      const note = reached < lines.length ? `\n[...共 ${lines.length} 行，已显示到第 ${reached} 行]` : ''

      return {
        content: [{ type: 'text' as const, text: numbered + note }],
        details: { lines: lines.length, shown: slice.length, bytes: buffer.length },
      }
    },
  }
}
