/** UUIDv7 生成单测（design 5.10.2）：格式、版本位与时间有序性。 */

import { describe, expect, it } from 'vitest'

import { uuidv7 } from '../src/main/cloud/uuidv7'

describe('uuidv7', () => {
  it('生成合法 UUID 且版本/变体位正确', () => {
    const value = uuidv7()
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('同一毫秒内不重复', () => {
    const values = new Set(Array.from({ length: 200 }, () => uuidv7()))
    expect(values.size).toBe(200)
  })

  it('时间戳随调用递增（跨毫秒时前缀变大）', async () => {
    const first = uuidv7()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = uuidv7()
    expect(second.slice(0, 13) > first.slice(0, 13)).toBe(true)
  })
})
