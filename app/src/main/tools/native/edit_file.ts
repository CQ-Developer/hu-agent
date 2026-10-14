/**
 * pi 原生工具（R2）：`edit_file`。
 *
 * 行为与旧实现一致：精确匹配、匹配必须唯一（否则报出行号）、保留原换行风格、
 * 写入前备份到 `<workspace>/.hu/backups/`、临时文件 + rename。
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { Type } from 'typebox'

import { resolveInWorkspace } from '../path-guard'
import { ToolFailure, type NativeTool, type ToolFactoryOptions } from './tool'

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

function lineNumbersOf(haystack: string, needle: string): number[] {
  const lines: number[] = []
  let index = haystack.indexOf(needle)
  while (index >= 0) {
    lines.push(haystack.slice(0, index).split('\n').length)
    index = haystack.indexOf(needle, index + needle.length)
  }
  return lines
}

async function backup(target: string, workspaceRoot: string): Promise<void> {
  const dir = join(workspaceRoot, '.hu', 'backups')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  await copyFile(target, join(dir, `${basename(target)}.${stamp}.bak`))
}

export function createEditFileTool(options: ToolFactoryOptions): NativeTool {
  return {
    name: 'edit_file',
    label: '编辑文件',
    category: 'write',
    description: '在文件中精确替换一段文本。匹配必须唯一（否则请提供更多上下文或 replace_all=true）。',
    parameters: Type.Object({
      path: Type.String({ description: '文件路径' }),
      old_text: Type.String({ description: '要被替换的原文（必须与文件内容精确一致）' }),
      new_text: Type.String({ description: '替换后的文本' }),
      replace_all: Type.Optional(Type.Boolean({ description: '是否替换全部匹配（默认 false）' })),
    }),
    execute: async (_toolCallId, params) => {
      const input = params as { path: string; old_text: string; new_text: string; replace_all?: boolean }
      const target = resolveInWorkspace(options.workspaceRoot, input.path)

      const original = await readFile(target, 'utf8').catch(() => null)
      if (original === null) throw new ToolFailure(`文件不存在：${input.path}`)
      if (!input.old_text) throw new ToolFailure('old_text 不能为空')

      const eol = original.includes('\r\n') ? '\r\n' : '\n'
      const normalized = normalize(original)
      const needle = normalize(input.old_text)
      const occurrences = countOccurrences(normalized, needle)

      if (occurrences === 0) {
        throw new ToolFailure(`未找到匹配文本（注意空格与换行必须完全一致）：${input.path}`)
      }
      if (occurrences > 1 && input.replace_all !== true) {
        const lines = lineNumbersOf(normalized, needle).join(', ')
        throw new ToolFailure(
          `匹配到 ${occurrences} 处（行：${lines}），无法确定目标；请提供更多上下文或使用 replace_all=true。`,
        )
      }

      const replaced =
        input.replace_all === true
          ? normalized.split(needle).join(normalize(input.new_text))
          : normalized.replace(needle, normalize(input.new_text))
      const restored = eol === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced

      await backup(target, options.workspaceRoot)
      const temp = `${target}.tmp-${process.pid}`
      await writeFile(temp, restored, 'utf8')
      await rename(temp, target)

      return {
        content: [{ type: 'text' as const, text: `已修改 ${input.path}（替换 ${occurrences} 处）` }],
        details: { bytes: Buffer.byteLength(restored, 'utf8'), occurrences },
      }
    },
  }
}
