/** 流式 ZIP 打包单测：与读取器互为逆操作，并校验摘要与进度。 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { extractZip } from '../src/main/market/zip'
import { writeZipToFile } from '../src/main/sync/zip_write'

const LIMITS = {
  maxFiles: 100,
  maxTotalUncompressed: 64 * 1024 * 1024,
  maxCompressionRatio: 2000,
  maxEntrySize: 32 * 1024 * 1024,
}

describe('writeZipToFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-zipwrite-'))
    await mkdir(join(dir, 'src'), { recursive: true })
    await mkdir(join(dir, '.hu', 'sessions'), { recursive: true })
    await writeFile(join(dir, 'README.md'), '# hello\n', 'utf8')
    await writeFile(join(dir, 'src', 'index.ts'), 'export const x = 1\n', 'utf8')
    await writeFile(join(dir, '.hu', 'sessions', 's1.jsonl'), '{"type":"meta"}\n', 'utf8')
    // 一个较大的已压缩文件，走 store 分支
    await writeFile(join(dir, 'big.bin'), Buffer.alloc(9 * 1024 * 1024, 7))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('写出的 zip 可被读取器还原，摘要与文件一致', async () => {
    const target = join(dir, 'snapshot.zip')
    const progress: number[] = []
    const result = await writeZipToFile(
      target,
      [
        { path: 'README.md', sourcePath: join(dir, 'README.md'), size: 8 },
        { path: 'src/index.ts', sourcePath: join(dir, 'src/index.ts'), size: 19 },
        { path: '.hu/sessions/s1.jsonl', sourcePath: join(dir, '.hu', 'sessions', 's1.jsonl'), size: 16 },
        { path: 'big.bin', sourcePath: join(dir, 'big.bin'), size: 9 * 1024 * 1024 },
      ],
      { onProgress: (done) => progress.push(done) },
    )

    expect(result.fileCount).toBe(4)
    expect(progress).toEqual([1, 2, 3, 4])

    const data = await readFile(target)
    expect(result.sizeBytes).toBe(data.length)
    expect(result.digest).toBe(`sha256:${createHash('sha256').update(data).digest('hex')}`)

    const extracted = extractZip(data, LIMITS)
    expect(extracted.entries.map((entry) => entry.path).sort()).toEqual([
      '.hu/sessions/s1.jsonl',
      'README.md',
      'big.bin',
      'src/index.ts',
    ])
    expect(extracted.files.find((file) => file.path === 'README.md')?.data.toString()).toBe('# hello\n')
    expect(extracted.files.find((file) => file.path === 'big.bin')?.data.length).toBe(9 * 1024 * 1024)
    expect(extracted.totalUncompressed).toBe(8 + 19 + 16 + 9 * 1024 * 1024)
  })

  it('空清单也能生成合法 zip', async () => {
    const target = join(dir, 'empty.zip')
    const result = await writeZipToFile(target, [])
    expect(result.fileCount).toBe(0)
    const data = await readFile(target)
    // 22 字节 EOCD
    expect(data.length).toBe(22)
    expect(() => extractZip(data, LIMITS)).toThrow(/没有文件/)
  })
})
