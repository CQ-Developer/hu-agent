/** 把会话 JSONL 行转换为 UI 视图项（design 5.3.2 / 5.2.6）。纯函数，便于单测。 */

import type { SessionItemView } from '../../shared/ipc'
import type { SessionLine } from './types'

export function buildSessionItems(lines: SessionLine[]): SessionItemView[] {
  const items: SessionItemView[] = []
  const toolIndex = new Map<string, number>()

  for (const line of lines) {
    if (line.type === 'message') {
      const text = line.parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('')
      const reasoning = line.parts
        .filter((part) => part.type === 'reasoning')
        .map((part) => part.text)
        .join('')
      items.push({
        kind: 'message',
        id: line.id,
        role: line.role,
        text,
        reasoning: reasoning || undefined,
        createdAt: line.createdAt,
      })
    } else if (line.type === 'tool_call') {
      toolIndex.set(line.id, items.length)
      items.push({
        kind: 'tool',
        id: line.id,
        name: line.name,
        input: line.args,
        createdAt: line.createdAt,
      })
    } else if (line.type === 'tool_result') {
      const index = toolIndex.get(line.id)
      if (index !== undefined) {
        const item = items[index]
        if (item.kind === 'tool') {
          item.status = line.status
          item.output = line.output
          item.durationMs = line.durationMs
          item.truncated = line.truncated
          item.artifactPath = line.artifactPath
        }
      }
    }
  }
  return items
}
