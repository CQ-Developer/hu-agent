import { describe, expect, it } from 'vitest'

import { buildSessionItems } from '../src/main/session/items'
import type { SessionLine } from '../src/main/session/types'

const createdAt = new Date().toISOString()

describe('buildSessionItems', () => {
  it('把 reasoning 与 text 部分分别映射，并合并工具结果', () => {
    const lines: SessionLine[] = [
      {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: '内部思考' },
          { type: 'text', text: '正式回答' },
        ],
        createdAt,
      },
      { type: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' }, turnId: 't1', createdAt },
      { type: 'tool_result', id: 'c1', status: 'ok', output: '文件内容', durationMs: 3, createdAt },
    ]

    const items = buildSessionItems(lines)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'message', text: '正式回答', reasoning: '内部思考' })
    expect(items[1]).toMatchObject({ kind: 'tool', name: 'read_file', status: 'ok', output: '文件内容' })
  })

  it('没有 reasoning 时不产生冗余字段', () => {
    const lines: SessionLine[] = [
      {
        type: 'message',
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: '只有回答' }],
        createdAt,
      },
    ]
    const items = buildSessionItems(lines)
    expect(items[0]).toMatchObject({ kind: 'message', text: '只有回答' })
    expect((items[0] as { reasoning?: string }).reasoning).toBeUndefined()
  })
})
