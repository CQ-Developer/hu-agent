/**
 * i18n 测试（design 5.13 / D13）：
 * - 词典与源码严格一致（无漏翻、无死键、占位符一致）
 * - 渲染层不得残留未包裹 t() 的中文字面量
 * - 主进程仅允许「模型面向」文案保留中文（系统提示、工具描述、压缩提示）
 */

import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { KEY_REGISTRY } from '../scripts/i18n-config.mjs'
// @ts-expect-error —— .mjs 工具脚本（无类型声明）
import { collectKeys, collectPlainStrings, collectTranslatable } from '../scripts/i18n-scan.mjs'

import enUS from '../src/shared/i18n/en-US'
import { dictionaryKeys, interpolate, lookup, normalizeLocale, resolveLocale } from '../src/shared/i18n'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const RENDERER = join(appDir, 'src/renderer/src')
const MAIN = join(appDir, 'src/main')

/** 允许保留中文的**模型面向**文件（提示词、工具描述、压缩指令） */
const MAIN_ALLOWLIST = [
  join(MAIN, 'agent/prompt.ts'),
  join(MAIN, 'agent/compaction.ts'),
  join(MAIN, 'tools'),
  join(MAIN, 'mcp/manager.ts'), // MCP 工具描述来自 server，此处仅有兜底中文
]

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      // gallery：dev-only 设计画廊（生产构建不包含），仅供设计评审，不参与 i18n 检查
      if (name === 'i18n' || name === 'node_modules' || name === 'gallery') continue
      yield* walk(path)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && name !== 'en-US.ts') {
      yield path
    }
  }
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
}

describe('语言解析', () => {
  it('把系统语言归一为受支持语言', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-CN')
    expect(normalizeLocale('zh-Hans-CN')).toBe('zh-CN')
    expect(normalizeLocale('en-GB')).toBe('en-US')
    expect(normalizeLocale('fr-FR')).toBe('zh-CN')
    expect(normalizeLocale(null)).toBe('zh-CN')
  })

  it('偏好优先于系统语言', () => {
    expect(resolveLocale('en-US', 'zh-CN')).toBe('en-US')
    expect(resolveLocale('system', 'en-GB')).toBe('en-US')
    expect(resolveLocale('system', 'zh-TW')).toBe('zh-CN')
  })
})

describe('取词与插值', () => {
  it('中文直接用键本身，插值生效', () => {
    expect(lookup('zh-CN', '已检查 {checked} 个资源', { checked: 3 })).toBe('已检查 3 个资源')
  })

  it('英文查词典；缺键回退中文', () => {
    expect(lookup('en-US', '取消')).toBe('Cancel')
    expect(lookup('en-US', '这条文案还没翻译')).toBe('这条文案还没翻译')
  })

  it('位置占位符与未提供参数保持原样', () => {
    expect(interpolate('版本 v{0}', { 0: '1.2.0' })).toBe('版本 v1.2.0')
    expect(interpolate('缺失 {name} 占位符')).toBe('缺失 {name} 占位符')
    expect(interpolate('空值 {count}', { count: undefined })).toBe('空值 ')
  })

  it('英文复数按 count 选择', () => {
    const message: [string, string] = ['{count} file', '{count} files']
    expect(interpolate(message[0], { count: 1 })).toBe('1 file')
    expect(interpolate(message[1], { count: 2 })).toBe('2 files')
  })
})

describe('词典与源码一致性', () => {
  const keys = new Map<string, number>()
  for (const root of [RENDERER, MAIN]) {
    for (const file of walk(root)) {
      for (const { key } of collectKeys(readFileSync(file, 'utf8'), file)) {
        keys.set(key, (keys.get(key) ?? 0) + 1)
      }
    }
  }
  // 键注册表（业务码映射等）：文件里的中文串本身就是消息键
  for (const pattern of KEY_REGISTRY) {
    const file = join(appDir, pattern)
    for (const { key } of collectPlainStrings(readFileSync(file, 'utf8'), file)) {
      keys.set(key, (keys.get(key) ?? 0) + 1)
    }
  }
  const duplicates: string[] = []
  const translated = new Set(dictionaryKeys('en-US'))
  const used = new Set(keys.keys())

  it('源码用到的每个键都有英文译文', () => {
    const missing = [...used].filter((key) => !translated.has(key)).sort()
    expect(missing, `缺少英文译文：\n${missing.join('\n')}`).toEqual([])
  })

  it('词典中没有死键（未被任何源码使用）', () => {
    const dead = [...translated].filter((key) => !used.has(key)).sort()
    expect(dead, `词典中未被使用的键：\n${dead.join('\n')}`).toEqual([])
  })

  it('词典没有重复键（后者会静默覆盖前者）', () => {
    const source = readFileSync(join(appDir, 'src/shared/i18n/en-US.ts'), 'utf8')
    const seen = new Map<string, number>()
    source.split('\n').forEach((line, index) => {
      const match = /^  '(.+?)':/.exec(line)
      if (!match) return
      const previous = seen.get(match[1])
      if (previous !== undefined) duplicates.push(`${match[1]}（第 ${previous} 行与第 ${index + 1} 行）`)
      seen.set(match[1], index + 1)
    })
    expect(duplicates, `重复键：\n${duplicates.join(', ')}`).toEqual([])
  })

  it('占位符集合与译文一致', () => {
    const mismatched: string[] = []
    for (const [key, message] of Object.entries(enUS)) {
      const values = Array.isArray(message) ? message : [message]
      for (const value of values) {
        if (placeholders(value).join(',') !== placeholders(key).join(',')) {
          mismatched.push(`${key} -> ${value}`)
        }
      }
    }
    expect(mismatched, `占位符不一致：\n${mismatched.join('\n')}`).toEqual([])
  })

  it('译文不含中文（未漏翻成中文）', () => {
    const chinese = Object.entries(enUS).filter(([, message]) =>
      (Array.isArray(message) ? message : [message]).some((value) => /[\u3000-\u9fff]/.test(value)),
    )
    expect(chinese.map(([key]) => key)).toEqual([])
  })
})

describe('源码无漏翻', () => {
  it('渲染层不存在未包裹 t() 的中文文案', () => {
    const leftovers: string[] = []
    for (const file of walk(RENDERER)) {
      for (const entry of collectTranslatable(readFileSync(file, 'utf8'), file)) {
        leftovers.push(`${relative(appDir, file)} [${entry.kind}] ${entry.key}`)
      }
    }
    expect(leftovers, `未包裹 t() 的文案：\n${leftovers.join('\n')}`).toEqual([])
  })

  it('主进程仅有模型面向文案保留中文', () => {
    const leftovers: string[] = []
    for (const file of walk(MAIN)) {
      if (MAIN_ALLOWLIST.some((allowed) => file.startsWith(allowed))) continue
      for (const entry of collectTranslatable(readFileSync(file, 'utf8'), file)) {
        leftovers.push(`${relative(appDir, file)} [${entry.kind}] ${entry.key}`)
      }
    }
    expect(leftovers, `主进程未本地化的用户可见文案：\n${leftovers.join('\n')}`).toEqual([])
  })
})
