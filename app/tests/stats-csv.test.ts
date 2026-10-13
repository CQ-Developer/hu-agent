/** CSV 导出单测（design 6.7 统计导出）。 */

import { describe, expect, it } from 'vitest'

import { csvBlob, escapeCsvField, toCsv } from '../src/renderer/src/lib/csv'

describe('escapeCsvField', () => {
  it('普通值原样输出，空值输出空串', () => {
    expect(escapeCsvField('abc')).toBe('abc')
    expect(escapeCsvField(123)).toBe('123')
    expect(escapeCsvField(null)).toBe('')
    expect(escapeCsvField(undefined)).toBe('')
  })

  it('包含逗号/引号/换行的值加引号并转义', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
  })
})

describe('toCsv', () => {
  it('使用 CRLF 行尾并包含表头', () => {
    const csv = toCsv(['日期', 'tokens'], [['2026-10-01', 1234]])
    expect(csv).toBe('日期,tokens\r\n2026-10-01,1234\r\n')
  })

  it('转义内容中的逗号与引号', () => {
    const csv = toCsv(['模型'], [['say "x", y']])
    expect(csv).toBe('模型\r\n"say ""x"", y"\r\n')
  })
})

describe('csvBlob', () => {
  it('带 UTF-8 BOM 便于 Excel 识别', async () => {
    const blob = csvBlob('a,b\r\n')
    expect(blob.type).toContain('text/csv')
    // Blob.text() 会按规范去掉 BOM，因此直接检查字节
    const bytes = new Uint8Array(await blob.arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('a,b\r\n')
  })
})
