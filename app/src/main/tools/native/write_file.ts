/**
 * pi 原生工具（R2）：`write_file`。
 *
 * 行为与旧实现一致：自动创建父目录、目标已存在时必须显式 `overwrite: true`、
 * 临时文件 + rename（避免留下半成品）。
 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { Type } from 'typebox'

import { resolveInWorkspace } from '../path-guard'
import { ToolFailure, type NativeTool, type ToolFactoryOptions } from './tool'

export function createWriteFileTool(options: ToolFactoryOptions): NativeTool {
  return {
    name: 'write_file',
    label: '写入文件',
    category: 'write',
    description: '写入文本文件（自动创建父目录）。目标已存在时必须显式 overwrite=true。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径' }),
      content: Type.String({ description: '文件内容' }),
      overwrite: Type.Optional(Type.Boolean({ description: '是否覆盖已存在文件（默认 false）' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { path: string; content: string; overwrite?: boolean }
      const target = resolveInWorkspace(options.workspaceRoot, input.path)

      const exists = (await stat(target).catch(() => null))?.isFile() ?? false
      if (exists && input.overwrite !== true) {
        throw new ToolFailure(`文件已存在：${input.path}（如需覆盖请传 overwrite=true）`)
      }

      await mkdir(dirname(target), { recursive: true })
      const temp = `${target}.tmp-${process.pid}`
      await writeFile(temp, input.content, 'utf8')
      await rename(temp, target)

      const bytes = Buffer.byteLength(input.content, 'utf8')
      return {
        content: [{ type: 'text' as const, text: `已写入 ${input.path}（${bytes} 字节）` }],
        details: { bytes },
      }
    },
  }
}
