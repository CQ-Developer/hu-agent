/** ZIP 读取器安全单测（design 6.4.2 / 5.7.5）：路径逃逸、符号链接、炸弹、损坏数据。 */

import { describe, expect, it } from 'vitest'

import { ZipError, extractZip, normalizeZipPath, type ZipLimits } from '../src/main/market/zip'
import { buildZip } from './helpers/zip_writer'

const LIMITS: ZipLimits = {
  maxFiles: 10,
  maxTotalUncompressed: 1024 * 1024,
  maxCompressionRatio: 50,
  maxEntrySize: 256 * 1024,
}

const SKILL_MD = '---\nname: demo\ndescription: 演示\nversion: 1.0.0\n---\n正文\n'

describe('normalizeZipPath', () => {
  it('规范化合法路径并识别目录', () => {
    expect(normalizeZipPath('a/b.txt')).toBe('a/b.txt')
    expect(normalizeZipPath('a//b.txt')).toBe('a/b.txt')
    expect(normalizeZipPath('dir/')).toBeNull()
  })

  it('拒绝不安全路径', () => {
    for (const bad of ['/abs.txt', 'a\\b.txt', 'C:/x.txt', '../evil', 'a/../../evil', '']) {
      expect(() => normalizeZipPath(bad), bad).toThrow(ZipError)
    }
  })
})

describe('extractZip', () => {
  it('解压 stored 与 deflate 条目并识别脚本', () => {
    const zip = buildZip([
      { path: 'SKILL.md', data: SKILL_MD },
      { path: 'scripts/run.sh', data: '#!/bin/sh\necho hi\n', method: 'deflate' },
      { path: 'assets/logo.png', data: '\x89PNG-data' },
    ])
    const result = extractZip(zip, LIMITS)
    expect(result.entries.map((entry) => entry.path)).toEqual([
      'SKILL.md',
      'scripts/run.sh',
      'assets/logo.png',
    ])
    expect(result.entries[1]?.script).toBe(true)
    expect(result.entries[0]?.script).toBe(false)
    expect(result.files.find((file) => file.path === 'scripts/run.sh')?.data.toString()).toContain('echo hi')
    expect(result.totalUncompressed).toBeGreaterThan(0)
  })

  it('跳过目录条目', () => {
    const zip = buildZip([{ path: 'dir/' }, { path: 'dir/a.txt', data: 'x' }])
    expect(extractZip(zip, LIMITS).files.map((file) => file.path)).toEqual(['dir/a.txt'])
  })

  it('拒绝 zip-slip / 绝对路径 / 反斜杠 / 重复路径', () => {
    expect(() => extractZip(buildZip([{ path: '../evil.sh', data: 'x' }]), LIMITS)).toThrow(/上级目录/)
    expect(() => extractZip(buildZip([{ path: '/etc/passwd', data: 'x' }]), LIMITS)).toThrow(/绝对路径/)
    expect(() => extractZip(buildZip([{ path: 'a\\b.txt', data: 'x' }]), LIMITS)).toThrow(/反斜杠/)
    expect(() =>
      extractZip(buildZip([{ path: 'a.txt', data: '1' }, { path: 'a.txt', data: '2' }]), LIMITS),
    ).toThrow(/重复路径/)
  })

  it('拒绝符号链接与加密条目', () => {
    expect(() => extractZip(buildZip([{ path: 'link', data: 'target', symlink: true }]), LIMITS)).toThrow(/符号链接/)
    expect(() => extractZip(buildZip([{ path: 'a.txt', data: 'x', flags: 0x1 }]), LIMITS)).toThrow(/加密/)
  })

  it('拒绝超限文件数、单文件体积与压缩比', () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ path: `f${index}.txt`, data: 'x' }))
    expect(() => extractZip(buildZip(many), LIMITS)).toThrow(/文件数超过上限/)

    const big = 'x'.repeat(300 * 1024)
    expect(() => extractZip(buildZip([{ path: 'big.txt', data: big }]), LIMITS)).toThrow(/单个文件超过上限/)

    const bomb = buildZip([{ path: 'bomb.txt', data: '0'.repeat(200 * 1024), method: 'deflate' }])
    expect(() => extractZip(bomb, LIMITS)).toThrow(/zip 炸弹|总大小超过上限/)
  })

  it('拒绝损坏数据：CRC 不符、长度不符、截断、非 zip', () => {
    expect(() => extractZip(buildZip([{ path: 'a.txt', data: 'hello', crcOverride: 0 }]), LIMITS)).toThrow(/CRC/)
    expect(() =>
      extractZip(buildZip([{ path: 'a.txt', data: 'hello', declaredUncompressed: 99 }]), LIMITS),
    ).toThrow(ZipError)
    const zip = buildZip([{ path: 'a.txt', data: 'hello' }])
    expect(() => extractZip(zip.subarray(0, zip.length - 10), LIMITS)).toThrow(ZipError)
    expect(() => extractZip(Buffer.from('not a zip at all'), LIMITS)).toThrow(ZipError)
  })

  it('拒绝 Zip64 标记', () => {
    const zip = buildZip([{ path: 'a.txt', data: 'x', declaredUncompressed: 0xffffffff }])
    expect(() => extractZip(zip, LIMITS)).toThrow(/Zip64/)
  })

  it('不接受不支持的压缩方式', () => {
    // 手工构造 method=12 的目录条目
    const zip = buildZip([{ path: 'a.txt', data: 'x' }])
    const centralOffset = zip.readUInt32LE(zip.length - 22 + 16)
    zip.writeUInt16LE(12, centralOffset + 10)
    expect(() => extractZip(zip, LIMITS)).toThrow(/不支持的压缩方式/)
  })
})
