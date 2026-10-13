/** edit_file：精确匹配替换（design 5.4.2：匹配必须唯一，保留换行风格，修改前备份）。 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { resolveInWorkspace } from './path-guard'
import { defineTool, type ToolResult } from './types'

interface Input {
  path: string
  old_text: string
  new_text: string
  replace_all?: boolean
}

export const editFileTool = defineTool<Input>({
  name: 'edit_file',
  description: '在文件中精确替换一段文本。匹配必须唯一（否则请提供更多上下文或 replace_all=true）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_text: { type: 'string', description: '要被替换的原文（必须与文件内容精确一致）' },
      new_text: { type: 'string', description: '替换后的文本' },
      replace_all: { type: 'boolean', description: '是否替换全部匹配（默认 false）' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  async run(input, ctx): Promise<ToolResult> {
    const target = resolveInWorkspace(ctx.workspaceRoot, input.path)
    const original = await readFile(target, 'utf8').catch(() => null)
    if (original === null) return { status: 'error', output: `文件不存在：${input.path}` }
    if (!input.old_text) return { status: 'error', output: 'old_text 不能为空' }

    const eol = original.includes('\r\n') ? '\r\n' : '\n'
    const normalized = normalize(original)
    const needle = normalize(input.old_text)
    const occurrences = countOccurrences(normalized, needle)

    if (occurrences === 0) {
      return { status: 'error', output: `未找到匹配文本（注意空格与换行必须完全一致）：${input.path}` }
    }
    if (occurrences > 1 && input.replace_all !== true) {
      const lines = lineNumbersOf(normalized, needle).join(', ')
      return {
        status: 'error',
        output: `匹配到 ${occurrences} 处（行：${lines}），无法确定目标；请提供更多上下文或使用 replace_all=true。`,
      }
    }

    const replaced =
      input.replace_all === true
        ? normalized.split(needle).join(normalize(input.new_text))
        : normalized.replace(needle, normalize(input.new_text))
    const restored = eol === '\r\n' ? replaced.replace(/\n/g, '\r\n') : replaced

    await backup(target, ctx.workspaceRoot)
    const temp = `${target}.tmp-${process.pid}`
    await writeFile(temp, restored, 'utf8')
    await rename(temp, target)

    return {
      status: 'ok',
      output: `已修改 ${input.path}（替换 ${occurrences} 处）`,
      metadata: { bytes: Buffer.byteLength(restored, 'utf8') },
    }
  },
})

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
