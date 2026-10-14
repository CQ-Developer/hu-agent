/**
 * i18n 范围配置：哪些主进程文件属于「模型面向」文案（不本地化）。
 *
 * 设计取舍（design 5.2.3 / 5.13）：系统提示、压缩指令与工具描述保持单语言书写，
 * 避免提示词质量受翻译影响；模型回复语言由系统提示**注入当前语言**决定，
 * 而不是翻译提示词本体。
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')

export const MAIN = join(appDir, 'src/main')
export const RENDERER = join(appDir, 'src/renderer/src')

/** 模型面向文件/目录（相对 app/src/main） */
export const MODEL_FACING = [
  'agent/prompt.ts',
  'agent/compaction.ts',
  'tools/',
  'mcp/manager.ts',
]

/** 「键注册表」：文件里的中文串本身就是消息键，不参与翻译（如业务码映射） */
export const KEY_REGISTRY = ['src/shared/i18n/error-codes.ts']

export function isKeyRegistry(file) {
  const normalized = file.replace(/\\/g, '/')
  return KEY_REGISTRY.some((pattern) => normalized.endsWith(pattern))
}

export function isModelFacing(file) {
  return MODEL_FACING.some((pattern) => file.includes(join(MAIN, pattern).replace(/\\/g, '/')) ||
    file.replace(/\\/g, '/').includes(`src/main/${pattern}`))
}
