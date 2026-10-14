#!/usr/bin/env node
/**
 * i18n 一致性检查（与 tests/i18n.test.ts 同源，但可在 CI/本地快速运行）：
 *   node scripts/i18n-check.mjs out.txt     # 输出缺译文/死键清单（UTF-8 文件，避免控制台编码问题）
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'

import { KEY_REGISTRY } from './i18n-config.mjs'
import { collectKeys, collectPlainStrings } from './i18n-scan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === 'i18n' || name === 'node_modules') continue
      yield* walk(path)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && name !== 'en-US.ts') {
      yield path
    }
  }
}

const used = new Map()
for (const root of [join(appDir, 'src/renderer/src'), join(appDir, 'src/main')]) {
  for (const file of walk(root)) {
    for (const { key } of collectKeys(readFileSync(file, 'utf8'), file)) {
      used.set(key, (used.get(key) ?? 0) + 1)
    }
  }
}
// 键注册表（业务码映射等）：文件里的中文串本身就是消息键
for (const pattern of KEY_REGISTRY) {
  const file = join(appDir, pattern)
  for (const { key } of collectPlainStrings(readFileSync(file, 'utf8'), file)) {
    used.set(key, (used.get(key) ?? 0) + 1)
  }
}

// 用 TS API 读取词典键（避免正则处理转义）
const dictFile = join(appDir, 'src/shared/i18n/en-US.ts')
const source = ts.createSourceFile(dictFile, readFileSync(dictFile, 'utf8'), ts.ScriptTarget.Latest, true)
const dictionary = new Set()
const visit = (node) => {
  if (ts.isVariableDeclaration(node) && node.name.getText() === 'enUS' && node.initializer) {
    if (ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name)) {
          dictionary.add(property.name.text)
        }
      }
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)

const missing = [...used.keys()].filter((key) => !dictionary.has(key)).sort()
const dead = [...dictionary].filter((key) => !used.has(key)).sort()
const output = [
  `used=${used.size} dict=${dictionary.size} missing=${missing.length} dead=${dead.length}`,
  '',
  '#### 缺译文（源码用到但词典没有）',
  ...missing,
  '',
  '#### 死键（词典有但源码未用）',
  ...dead,
].join('\n')

const target = process.argv[2]
if (target) writeFileSync(target, output + '\n', 'utf8')
console.log(`used=${used.size} dict=${dictionary.size} missing=${missing.length} dead=${dead.length}`)
if (target) console.log(`详情 -> ${relative(process.cwd(), target)}`)
