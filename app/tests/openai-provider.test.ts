/** OpenAI 兼容 SSE 解析单测：不依赖网络，覆盖工具调用增量拼接（真实模型测试暴露过的回归点）。 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamOpenAiChat } from '../src/main/model/providers/openai'
import type { StreamEvent } from '../src/main/model/types'

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

async function collect(): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const event of streamOpenAiChat({
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'write_file', description: '写文件', parameters: { type: 'object' } }],
    apiKey: 'test-key',
  })) {
    events.push(event)
  }
  return events
}

describe('streamOpenAiChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('解析文本增量、嵌套 function 的工具调用（参数跨块）与 usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"我来写"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"文件。"}}]}\n\n',
          // 工具调用：name 在 function 下，arguments 分两块传输（与 OpenAI/DeepSeek 一致）
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\",\\"content\\":\\"hi\\"}"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    )

    const events = await collect()
    const text = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.type === 'text_delta' ? event.text : ''))
      .join('')
    expect(text).toBe('我来写文件。')

    const toolCall = events.find((event) => event.type === 'tool_call')
    expect(toolCall && toolCall.type === 'tool_call' ? toolCall.call : undefined).toEqual({
      id: 'call_1',
      name: 'write_file',
      input: { path: 'a.txt', content: 'hi' },
    })

    const usage = events.find((event) => event.type === 'usage')
    expect(usage && usage.type === 'usage' ? usage.usage : undefined).toMatchObject({ inputTokens: 11, outputTokens: 7 })

    const done = events.at(-1)
    expect(done && done.type === 'done' ? done.stopReason : undefined).toBe('tool_use')
  })

  it('兼容省略 index 的兼容服务（按数组位置归并）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_x","function":{"name":"bash","arguments":"{\\"command\\":"}}]}}]}\n\n',
          'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"\\"ls\\"}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      ),
    )

    const events = await collect()
    const toolCall = events.find((event) => event.type === 'tool_call')
    expect(toolCall && toolCall.type === 'tool_call' ? toolCall.call : undefined).toEqual({
      id: 'call_x',
      name: 'bash',
      input: { command: 'ls' },
    })
  })

  it('HTTP 错误按模型错误分类抛出', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"rate limited"}', { status: 429 })),
    )
    await expect(collect()).rejects.toMatchObject({ kind: 'rate_limit', retryable: true })
  })
})
