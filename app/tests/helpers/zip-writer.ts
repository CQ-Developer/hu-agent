/** 测试用最小 ZIP 写入器（stored/deflate），支持注入非法结构以验证解析器防护。 */

import { deflateRawSync } from 'node:zlib'

import { crc32 } from '../../src/main/market/zip'

export interface WriteEntry {
  path: string
  data?: string | Buffer
  method?: 'store' | 'deflate'
  /** 符号链接条目（external attr 标记） */
  symlink?: boolean
  /** 覆盖 CRC（用于构造校验失败） */
  crcOverride?: number
  /** 覆盖压缩后字节（用于构造截断/长度不符） */
  compressedOverride?: Buffer
  /** 覆盖目录声明的解压后大小 */
  declaredUncompressed?: number
  /** 覆盖目录声明的压缩后大小 */
  declaredCompressed?: number
  /** 覆盖通用标志位（如设置 bit0 表示加密） */
  flags?: number
}

export function buildZip(entries: WriteEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const method = entry.method ?? 'store'
    const compressed = entry.compressedOverride ?? (method === 'deflate' ? deflateRawSync(raw) : raw)
    const crc = entry.crcOverride ?? crc32(raw)
    const uncompressedSize = entry.declaredUncompressed ?? raw.length
    const compressedSize = entry.declaredCompressed ?? compressed.length
    const flags = entry.flags ?? 0
    const name = Buffer.from(entry.path, 'utf8')

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(flags, 6)
    localHeader.writeUInt16LE(method === 'deflate' ? 8 : 0, 8)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(compressedSize, 18)
    localHeader.writeUInt32LE(uncompressedSize, 22)
    localHeader.writeUInt16LE(name.length, 26)
    locals.push(localHeader, name, compressed)

    const externalAttr = entry.symlink ? (0o120777 << 16) >>> 0 : 0
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(flags, 8)
    centralHeader.writeUInt16LE(method === 'deflate' ? 8 : 0, 10)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressedSize, 20)
    centralHeader.writeUInt32LE(uncompressedSize, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(externalAttr, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centrals.push(centralHeader, name)

    offset += localHeader.length + name.length + compressed.length
  }

  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, ...centrals, eocd])
}
