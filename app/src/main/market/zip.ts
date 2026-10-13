/** 最小 ZIP 读取器（design 6.4.2 / 5.7.5）：只依赖 node:zlib，严格实现安全限制。
 *
 * 支持：stored / deflate、UTF-8 路径、单一中央目录（非 Zip64）。
 * 拒绝：加密条目、Zip64、绝对路径/`..`/反斜杠/盘符、符号链接、超限文件数与体积、异常压缩比、
 *      数据截断、长度不符与 CRC 校验失败。
 */

import { inflateRawSync } from 'node:zlib'

export interface ZipLimits {
  maxFiles: number
  maxTotalUncompressed: number
  maxCompressionRatio: number
  maxEntrySize: number
}

export interface ZipEntry {
  path: string
  size: number
  script: boolean
}

export interface ExtractedFile {
  path: string
  data: Buffer
}

export interface ExtractResult {
  files: ExtractedFile[]
  entries: ZipEntry[]
  totalUncompressed: number
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_SIZE = 22
const MAX_COMMENT = 0xffff
const ZIP64_SENTINEL = 0xffffffff

const SCRIPT_SUFFIXES = [
  '.sh',
  '.bash',
  '.ps1',
  '.bat',
  '.cmd',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.exe',
]

/** 规范化并校验 zip 内路径；目录条目返回 null，非法路径抛 ZipError。 */
export function normalizeZipPath(name: string): string | null {
  if (name.length === 0) throw new ZipError('包含空路径条目')
  if (name.includes('\\')) throw new ZipError(`包含反斜杠路径（请使用 /）：${name}`)
  if (name.startsWith('/')) throw new ZipError(`包含绝对路径：${name}`)
  if (name.length > 2 && name[1] === ':') throw new ZipError(`包含盘符路径：${name}`)
  const isDirectory = name.endsWith('/')
  const parts = name.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.some((part) => part === '..')) throw new ZipError(`包含上级目录引用：${name}`)
  if (parts.length === 0) return null
  const normalized = parts.join('/')
  return isDirectory ? null : normalized
}

export function extractZip(data: Buffer, limits: ZipLimits): ExtractResult {
  const central = readCentralDirectory(data)
  const seen = new Set<string>()
  const files: ExtractedFile[] = []
  const entries: ZipEntry[] = []
  let totalUncompressed = 0
  let totalCompressed = 0

  for (const header of central) {
    if (header.path.length === 0) continue // 目录条目
    if (seen.has(header.path)) throw new ZipError(`包含重复路径：${header.path}`)
    seen.add(header.path)
    if (files.length >= limits.maxFiles) throw new ZipError(`文件数超过上限（${limits.maxFiles}）`)
    if (header.uncompressedSize > limits.maxEntrySize) {
      throw new ZipError(`单个文件超过上限（${Math.floor(limits.maxEntrySize / (1024 * 1024))} MB）：${header.path}`)
    }
    totalUncompressed += header.uncompressedSize
    totalCompressed += header.compressedSize
    if (totalUncompressed > limits.maxTotalUncompressed) {
      throw new ZipError(`解压后总大小超过上限（${Math.floor(limits.maxTotalUncompressed / (1024 * 1024))} MB）`)
    }
    if (header.uncompressedSize / Math.max(header.compressedSize, 1) > limits.maxCompressionRatio) {
      throw new ZipError(`压缩比异常，疑似 zip 炸弹：${header.path}`)
    }

    const raw = readEntryData(data, header)
    let content: Buffer
    if (header.method === 0) content = raw
    else {
      try {
        content = inflateRawSync(raw, { maxOutputLength: limits.maxEntrySize })
      } catch {
        throw new ZipError(`解压失败（数据损坏或超出限制）：${header.path}`)
      }
    }
    if (content.length !== header.uncompressedSize) {
      throw new ZipError(`解压长度与目录声明不符：${header.path}`)
    }
    if (crc32(content) !== header.crc) throw new ZipError(`CRC 校验失败：${header.path}`)

    files.push({ path: header.path, data: content })
    entries.push({ path: header.path, size: content.length, script: isScript(header.path, content) })
  }

  if (files.length === 0) throw new ZipError('包内没有文件')
  if (totalUncompressed / Math.max(totalCompressed, 1) > limits.maxCompressionRatio) {
    throw new ZipError('压缩比异常，疑似 zip 炸弹')
  }
  return { files, entries, totalUncompressed }
}

interface CentralHeader {
  path: string
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

function readCentralDirectory(data: Buffer): CentralHeader[] {
  const eocd = findEocd(data)
  const entryCount = data.readUInt16LE(eocd + 10)
  const centralSize = data.readUInt32LE(eocd + 12)
  const centralOffset = data.readUInt32LE(eocd + 16)
  if (centralOffset === ZIP64_SENTINEL || centralSize === ZIP64_SENTINEL || entryCount === 0xffff) {
    throw new ZipError('不支持 Zip64 格式的包')
  }
  if (centralOffset + centralSize > data.length) throw new ZipError('中央目录越界，文件可能被截断')

  const headers: CentralHeader[] = []
  let ptr = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (ptr + 46 > data.length) throw new ZipError('中央目录条目越界')
    if (data.readUInt32LE(ptr) !== CENTRAL_SIGNATURE) throw new ZipError('中央目录结构非法')
    const flags = data.readUInt16LE(ptr + 8)
    const method = data.readUInt16LE(ptr + 10)
    const crc = data.readUInt32LE(ptr + 16)
    const compressedSize = data.readUInt32LE(ptr + 20)
    const uncompressedSize = data.readUInt32LE(ptr + 24)
    const nameLength = data.readUInt16LE(ptr + 28)
    const extraLength = data.readUInt16LE(ptr + 30)
    const commentLength = data.readUInt16LE(ptr + 32)
    const externalAttr = data.readUInt32LE(ptr + 38)
    const localOffset = data.readUInt32LE(ptr + 42)

    if ((flags & 0x1) !== 0) throw new ZipError('包含加密条目，拒绝安装')
    if (method !== 0 && method !== 8) throw new ZipError(`不支持的压缩方式（method=${method}）`)
    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localOffset === ZIP64_SENTINEL
    ) {
      throw new ZipError('不支持 Zip64 格式的条目')
    }
    if ((externalAttr >> 16 & 0o170000) === 0o120000) {
      throw new ZipError(`包含符号链接条目：${decodeName(data, ptr + 46, nameLength)}`)
    }

    const rawName = decodeName(data, ptr + 46, nameLength)
    const path = normalizeZipPath(rawName) ?? ''
    headers.push({ path, method, crc, compressedSize, uncompressedSize, localOffset })
    ptr += 46 + nameLength + extraLength + commentLength
  }
  return headers
}

function readEntryData(data: Buffer, header: CentralHeader): Buffer {
  const ptr = header.localOffset
  if (ptr + 30 > data.length) throw new ZipError(`本地文件头越界：${header.path}`)
  if (data.readUInt32LE(ptr) !== LOCAL_SIGNATURE) throw new ZipError(`本地文件头非法：${header.path}`)
  const nameLength = data.readUInt16LE(ptr + 26)
  const extraLength = data.readUInt16LE(ptr + 28)
  const start = ptr + 30 + nameLength + extraLength
  const end = start + header.compressedSize
  if (end > data.length) throw new ZipError(`文件数据被截断：${header.path}`)
  return data.subarray(start, end)
}

function findEocd(data: Buffer): number {
  if (data.length < EOCD_MIN_SIZE) throw new ZipError('文件太小，不是合法的 zip 包')
  const earliest = Math.max(0, data.length - EOCD_MIN_SIZE - MAX_COMMENT)
  for (let ptr = data.length - EOCD_MIN_SIZE; ptr >= earliest; ptr -= 1) {
    if (data.readUInt32LE(ptr) === EOCD_SIGNATURE) return ptr
  }
  throw new ZipError('未找到 ZIP 结束记录（不是合法的 zip 包）')
}

function decodeName(data: Buffer, offset: number, length: number): string {
  return data.subarray(offset, offset + length).toString('utf8')
}

function isScript(path: string, content: Buffer): boolean {
  const lower = path.toLowerCase()
  if (SCRIPT_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  return content.length > 2 && content[0] === 0x23 && content[1] === 0x21 // #!
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 标准 CRC-32（与 zip 条目声明一致，用于数据完整性校验）。 */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
