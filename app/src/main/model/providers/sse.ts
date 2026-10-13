/** SSE 读取：把 `data:` 负载逐个产出（各家事件类型由调用方按 JSON.type 分派）。 */

import { ModelError } from '../errors'

export async function* readSseData(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new ModelError('server', '模型服务返回空响应体')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const takeLines = (): string[] => {
    const lines: string[] = []
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      lines.push(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
    }
    return lines
  }

  const payloadOf = (line: string): string | null => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith(':')) return null
    if (!trimmed.startsWith('data:')) return null
    const data = trimmed.slice(5).trim()
    return data.length > 0 ? data : null
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    for (const line of takeLines()) {
      const payload = payloadOf(line)
      if (payload) yield payload
    }
  }

  const tail = payloadOf(buffer)
  if (tail) yield tail
}
