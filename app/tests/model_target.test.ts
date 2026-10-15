/** 会话模型目标自愈（2026-10-15 缺陷回归）：旧 provider/模型失效时回退到当前默认。 */

import { describe, expect, it } from 'vitest'

import { healModelTarget, parseModelTarget } from '../src/main/session/model_target'

describe('会话模型目标', () => {
  it('parseModelTarget 按第一个斜杠切分，modelId 可含斜杠', () => {
    expect(parseModelTarget('token-hub/deepseek-v4.1-flash')).toEqual({
      provider: 'token-hub',
      modelId: 'deepseek-v4.1-flash',
    })
    expect(parseModelTarget('openrouter/deepseek/v3')).toEqual({ provider: 'openrouter', modelId: 'deepseek/v3' })
    expect(parseModelTarget('')).toBeNull()
    expect(parseModelTarget('nomodel')).toBeNull()
    expect(parseModelTarget('/x')).toBeNull()
    expect(parseModelTarget('x/')).toBeNull()
  })

  it('已存目标仍可用时不回退', () => {
    expect(healModelTarget('a/1', ['a/1', 'b/2'], 'b/2')).toEqual({ target: 'a/1', healed: false })
  })

  it('旧目标失效时回退到默认并标记需要持久化', () => {
    expect(healModelTarget('deepseek/deepseek-flash', ['token-hub/x'], 'token-hub/x')).toEqual({
      target: 'token-hub/x',
      healed: true,
    })
    expect(healModelTarget(undefined, ['token-hub/x'], 'token-hub/x')).toEqual({
      target: 'token-hub/x',
      healed: true,
    })
  })

  it('没有可用目标时返回 null', () => {
    expect(healModelTarget('deepseek/deepseek-flash', [], 'token-hub/x')).toEqual({ target: null, healed: false })
    expect(healModelTarget(undefined, ['a/1'], undefined)).toEqual({ target: null, healed: false })
  })
})
