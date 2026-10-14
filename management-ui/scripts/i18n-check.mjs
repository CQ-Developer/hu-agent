#!/usr/bin/env node
/**
 * 管理台 i18n 一致性检查（design 7.1）：
 *   node scripts/i18n-check.mjs [out.txt]
 * 报告：源码用到但词典缺失的键、词典中有但源码未用的键、中英键集合差异。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const localeDir = join(root, 'src/i18n/locales')

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules') continue
      yield* walk(path)
    } else if (/\.tsx?$/.test(name)) {
      yield path
    }
  }
}

/** 从 t('a.b', ...) 提取键（含 t(`a.b`) 模板形式） */
function collectUsedKeys(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const keys = []
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 't' && node.arguments.length) {
      const [first] = node.arguments
      if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) keys.push(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return keys
}

/** 解析 locales 的 export default 对象字面量 → 扁平键 */
function collectLocaleKeys(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const flat = new Map()
  const flatten = (node, prefix) => {
    if (!ts.isObjectLiteralExpression(node)) return
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const name = property.name.getText().replace(/^['"]|['"]$/g, '')
      const key = prefix ? `${prefix}.${name}` : name
      if (ts.isObjectLiteralExpression(property.initializer)) flatten(property.initializer, key)
      else flat.set(key, property.initializer.getText())
    }
  }
  const visit = (node) => {
    if (ts.isExportAssignment(node)) flatten(node.expression, '')
    ts.forEachChild(node, visit)
  }
  visit(source)
  return flat
}

const used = new Map()
for (const file of walk(join(root, 'src'))) {
  if (file.includes(`${join('src', 'i18n')}`)) continue
  for (const key of collectUsedKeys(file, readFileSync(file, 'utf8'))) {
    used.set(key, (used.get(key) ?? 0) + 1)
  }
}

const zh = collectLocaleKeys(join(localeDir, 'zh-CN.ts'))
const en = collectLocaleKeys(join(localeDir, 'en-US.ts'))
const missingZh = [...used.keys()].filter((key) => !zh.has(key)).sort()
const missingEn = [...used.keys()].filter((key) => !en.has(key)).sort()
const deadZh = [...zh.keys()].filter((key) => !used.has(key)).sort()
const parity = [
  ...[...zh.keys()].filter((key) => !en.has(key)).map((key) => `zh 有 en 无：${key}`),
  ...[...en.keys()].filter((key) => !zh.has(key)).map((key) => `en 有 zh 无：${key}`),
]

const lines = [
  `used=${used.size} zh=${zh.size} en=${en.size}`,
  `missingZh=${missingZh.length} missingEn=${missingEn.length} deadZh=${deadZh.length} parity=${parity.length}`,
  '',
  '#### 源码用到但 zh-CN 缺失',
  ...missingZh,
  '',
  '#### 源码用到但 en-US 缺失',
  ...missingEn,
  '',
  '#### zh-CN 中存在但源码未用（死键，可能含仅 dashboard/status 动态拼接的键）',
  ...deadZh,
  '',
  '#### 中英键集合差异',
  ...parity,
].join('\n')

const target = process.argv[2]
if (target) writeFileSync(target, `${lines}\n`, 'utf8')
console.log(lines.split('\n').slice(0, 2).join(' | '))
