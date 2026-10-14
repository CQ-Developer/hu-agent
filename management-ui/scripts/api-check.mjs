#!/usr/bin/env node
/**
 * 校验 src/api/schema.d.ts 与 openapi/openapi.json 同源（防止接口变更后忘记 `npm run api:gen`）。
 * 记录文件：src/api/schema.hash
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const spec = join(root, '..', 'openapi', 'openapi.json')
const record = join(root, 'src/api/schema.hash')
// 按 JSON 内容规范化后哈希：跨平台（CRLF/LF）与排版差异都不影响判定；
// 之前的字节哈希在 Windows（工作区 CRLF）与 Linux（LF）上不一致，导致 CI 误报「不同源」
const parsed = JSON.parse(readFileSync(spec, 'utf8'))
const digest = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')

if (process.argv.includes('--write')) {
  writeFileSync(record, `${digest}\n`, 'utf8')
  console.log(`已记录 openapi.json 摘要：${digest.slice(0, 12)}`)
  process.exit(0)
}

if (!existsSync(record) || readFileSync(record, 'utf8').trim() !== digest) {
  console.error('schema.d.ts 与 openapi/openapi.json 不同源：请运行 `npm run api:gen`（接口变更后必需）')
  process.exit(1)
}
console.log(`API 类型与 openapi.json 同源（${digest.slice(0, 12)}）`)
