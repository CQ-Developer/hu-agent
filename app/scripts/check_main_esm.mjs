/**
 * 主进程构建产物冒烟：确认输出是 ESM，且每个外部依赖都能按 ESM 条件解析。
 *
 * 背景：pi 包是 ESM-only（exports 只声明 `import` 条件）。主进程曾以 CJS 产出，
 * `require('@earendil-works/chord/context')` 直接 ERR_PACKAGE_PATH_NOT_EXPORTED，
 * 打包后的应用**起不来**——单测只加载源码、不加载构建产物，所以完全覆盖不到。
 *
 * 用法：`npm run build` 之后执行（CI 的 build 步骤已跟进；`npm run check` 也包含）。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const entry = new URL('../out/main/index.mjs', import.meta.url)
if (!existsSync(entry)) {
  console.error('[esm-smoke] 缺少构建产物 out/main/index.mjs（先 npm run build；这不是 CJS 形态）')
  process.exit(1)
}

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
if (typeof packageJson.main !== 'string' || !packageJson.main.endsWith('index.mjs')) {
  console.error(`[esm-smoke] package.json main 未指向 ESM 产物：${packageJson.main}`)
  process.exit(1)
}

const source = await readFile(entry, 'utf8')
const specifiers = new Set()
for (const match of source.matchAll(/(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g)) {
  specifiers.add(match[1])
}
for (const match of source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)) {
  specifiers.add(match[1])
}

const failures = []
for (const specifier of [...specifiers].sort()) {
  if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
  try {
    await import.meta.resolve(specifier)
  } catch (error) {
    failures.push(`${specifier}: ${error.code ?? ''} ${error.message}`)
  }
}

if (failures.length > 0) {
  console.error('[esm-smoke] 主进程外部依赖无法按 ESM 条件解析：')
  for (const line of failures) console.error('  - ' + line)
  process.exit(1)
}
console.log(`[esm-smoke] ok（${specifiers.size} 个 import，外部依赖全部可解析）`)
