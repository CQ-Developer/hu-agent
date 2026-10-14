#!/usr/bin/env node
/**
 * 把源码中的中文文案包进 t()（i18n 迁移工具）。可重复执行（已包裹的会跳过）。
 *
 *   node scripts/i18n-migrate.mjs --dry-run           # 只报告（默认）
 *   node scripts/i18n-migrate.mjs --write             # 写回
 *   node scripts/i18n-migrate.mjs --write --target main
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isModelFacing } from './i18n-config.mjs'
import { collectTranslatable, replacementFor } from './i18n-scan.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const appDir = resolve(here, '..')

const TARGETS = {
  renderer: { root: join(appDir, 'src/renderer/src'), module: join(appDir, 'src/renderer/src/i18n') },
  main: { root: join(appDir, 'src/main'), module: join(appDir, 'src/main/i18n') },
}

const args = process.argv.slice(2)
const write = args.includes('--write')
const targetArg = args.includes('--target') ? args[args.indexOf('--target') + 1] : 'renderer'
const targets = targetArg === 'both' ? ['renderer', 'main'] : [targetArg]

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const info = statSync(path)
    if (info.isDirectory()) {
      if (name === 'i18n' || name === 'node_modules') continue
      yield* walk(path)
    } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts') && !['i18n.ts', 'en-US.ts'].includes(name)) {
      yield path
    }
  }
}

function addImport(text, importPath) {
  if (new RegExp(`from '${importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(text)) return text
  const lines = text.split('\n')
  let lastImportEnd = -1
  let index = 0
  while (index < lines.length) {
    if (lines[index].startsWith('import ')) {
      while (!/['";]$/.test(lines[index].trimEnd()) && index + 1 < lines.length) index += 1
      lastImportEnd = index
    }
    index += 1
  }
  lines.splice(lastImportEnd + 1, 0, `import { t } from '${importPath}'`)
  return lines.join('\n')
}

let files = 0
let total = 0
for (const target of targets) {
  const { root, module } = TARGETS[target]
  for (const file of walk(root)) {
    if (target === 'main' && isModelFacing(file)) continue
    let output = readFileSync(file, 'utf8')
    let changed = 0
    // 两遍：先翻译模板插值内的字面量，再翻译模板本体（避免嵌套重叠）
    for (const includeTemplates of [false, true]) {
      const entries = collectTranslatable(output, file, { includeTemplates })
      if (entries.length === 0) continue
      const sorted = [...entries].sort((a, b) => b.node.getStart() - a.node.getStart())
      for (const entry of sorted) {
        const start = entry.node.getStart()
        const end = entry.node.getEnd()
        output = output.slice(0, start) + replacementFor(entry, output, entry.node.getSourceFile()) + output.slice(end)
        changed += 1
      }
    }
    if (changed === 0) continue
    if (write) {
      const importPath = relative(dirname(file), module).replace(/\\/g, '/')
      output = addImport(output, importPath.startsWith('.') ? importPath : `./${importPath}`)
      writeFileSync(file, output, 'utf8')
    }
    files += 1
    total += changed
    console.log(`${relative(appDir, file)}: ${changed}`)
  }
}

console.log(`\n${files} files, ${total} strings (${write ? 'written' : 'dry-run'})`)
