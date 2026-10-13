/** 流式 ZIP 打包（design 5.11.2）：把工作空间文件写成快照 zip，边写边算 sha256。
 *
 * 与 `market/zip.ts`（读取器）配套：本地 zip 格式为 stored/deflate、UTF-8 名称、
 * 不使用 Zip64（上限 2GB / 5 万文件由调用方保证）。
 */

import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { deflateRawSync } from 'node:zlib'

export interface ZipSource {
  /** zip 内相对路径（正斜杠） */
  path: string
  /** 本地绝对路径 */
  sourcePath: string
  size: number
  mtimeMs?: number
}

export interface ZipWriteResult {
  sizeBytes: number
  digest: string
  fileCount: number
}

const STORE_THRESHOLD_BYTES = 8 * 1024 * 1024
const ALREADY_COMPRESSED = ['.zip', '.gz', '.tgz', '.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mov', '.7z', '.pdf']

export async function writeZipToFile(
  target: string,
  sources: ZipSource[],
  options: { onProgress?: (done: number, total: number) => void } = {},
): Promise<ZipWriteResult> {
  const handle = await open(target, 'w')
  const hasher = createHash('sha256')
  let offset = 0

  const write = async (chunk: Buffer): Promise<void> => {
    hasher.update(chunk)
    await handle.write(chunk, 0, chunk.length, offset)
    offset += chunk.length
  }

  const centrals: Buffer[] = []
  let done = 0
  try {
    for (const source of sources) {
      const data = await readFile(source.sourcePath)
      const nameBuffer = Buffer.from(source.path, 'utf8')
      const method = shouldStore(source.path, data.length) ? 0 : 8
      const compressed = method === 8 ? deflateRawSync(data, { level: 6 }) : data
      const crc = crc32(data)
      const { time, date } = dosDateTime(source.mtimeMs ?? Date.now())

      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4) // version needed
      local.writeUInt16LE(0x800, 6) // UTF-8 名称
      local.writeUInt16LE(method, 8)
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(compressed.length, 18)
      local.writeUInt32LE(data.length, 22)
      local.writeUInt16LE(nameBuffer.length, 26)
      const localOffset = offset
      await write(local)
      await write(nameBuffer)
      await write(compressed)

      const central = Buffer.alloc(46)
      central.writeUInt32LE(0x02014b50, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(0x800, 8)
      central.writeUInt16LE(method, 10)
      central.writeUInt16LE(time, 12)
      central.writeUInt16LE(date, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(compressed.length, 20)
      central.writeUInt32LE(data.length, 24)
      central.writeUInt16LE(nameBuffer.length, 28)
      central.writeUInt32LE(0, 38) // external attrs：普通文件
      central.writeUInt32LE(localOffset, 42)
      centrals.push(central, nameBuffer)

      done += 1
      options.onProgress?.(done, sources.length)
    }

    const centralOffset = offset
    for (const chunk of centrals) await write(chunk)
    const centralSize = offset - centralOffset

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(sources.length, 8)
    eocd.writeUInt16LE(sources.length, 10)
    eocd.writeUInt32LE(centralSize, 12)
    eocd.writeUInt32LE(centralOffset, 16)
    await write(eocd)
  } finally {
    await handle.close()
  }

  return { sizeBytes: offset, digest: `sha256:${hasher.digest('hex')}`, fileCount: sources.length }
}

function shouldStore(path: string, size: number): boolean {
  if (size >= STORE_THRESHOLD_BYTES) return true
  const lower = path.toLowerCase()
  return ALREADY_COMPRESSED.some((suffix) => lower.endsWith(suffix))
}

function dosDateTime(epochMs: number): { time: number; date: number } {
  const date = new Date(epochMs)
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
