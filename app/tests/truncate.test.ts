import { describe, expect, it } from 'vitest'

import { truncateMiddle } from '../src/main/tools/truncate'

describe('truncateMiddle', () => {
  it('短输出不截断', () => {
    const result = truncateMiddle('hello', 100)
    expect(result.truncated).toBe(false)
    expect(result.output).toBe('hello')
  })

  it('长输出保留头尾并带 artifact 提示', () => {
    const text = 'a'.repeat(1000) + 'MIDDLE' + 'b'.repeat(1000)
    const result = truncateMiddle(text, 200, '.hu/sessions/artifacts/c1.txt')
    expect(result.truncated).toBe(true)
    expect(result.output).toContain('已截断')
    expect(result.output).toContain('.hu/sessions/artifacts/c1.txt')
    expect(result.output.startsWith('a'.repeat(100))).toBe(true)
    expect(result.output.endsWith('b'.repeat(80))).toBe(true)
  })
})
