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
const digest = createHash('sha256').update(readFileSync(spec)).digest('hex')

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
