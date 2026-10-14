#!/usr/bin/env node
/**
 * 报告 i18n 状态：
 *   node scripts/i18n-report.mjs --keys out.json      # 导出全部消息键（含占位符），用于编写 en-US 词典
 *   node scripts/i18n-report.mjs --untranslated       # 列出仍未被 t() 包裹的中文（漏翻）
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { KEY_REGISTRY } from './i18n-config.mjs'
import { collectKeys, collectPlainStrings, collectTranslatable } from './i18n-scan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')
const ROOTS = [join(appDir, 'src/renderer/src'), join(appDir, 'src/main')]
const SKIP_DIRS = new Set(['i18n', 'node_modules'])

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      yield* walk(path)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && name !== 'en-US.ts') {
      yield path
    }
  }
}

const args = process.argv.slice(2)
const keysOut = args.includes('--keys') ? args[args.indexOf('--keys') + 1] : null
const showUntranslated = args.includes('--untranslated')

const keys = new Map()
const untranslated = []
for (const root of ROOTS) {
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    for (const { key, params } of collectKeys(text, file)) {
      const existing = keys.get(key)
      if (existing) {
        existing.uses += 1
      } else {
        keys.set(key, { key, params, uses: 1 })
      }
    }
    if (showUntranslated) {
      for (const entry of collectTranslatable(text, file)) {
        untranslated.push({ file: relative(appDir, file), kind: entry.kind, key: entry.key })
      }
    }
  }
}

for (const pattern of KEY_REGISTRY) {
  const file = join(appDir, pattern)
  for (const { key, params } of collectPlainStrings(readFileSync(file, 'utf8'), file)) {
    if (!keys.has(key)) keys.set(key, { key, params, uses: 1 })
  }
}

if (keysOut) {
  const sorted = [...keys.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'))
  writeFileSync(keysOut, JSON.stringify(sorted, null, 2), 'utf8')
  console.log(`${sorted.length} keys -> ${keysOut}`)
} else {
  console.log(`${keys.size} unique keys`)
}

if (showUntranslated) {
  console.log(`untranslated: ${untranslated.length}`)
  for (const item of untranslated) console.log(`  ${item.file} [${item.kind}] ${item.key}`)
}
