/** OpenAI Responses API 适配单测（请求体转换 + SSE 事件解析）。 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamOpenAiResponses } from '../src/main/model/providers/openai-responses'
import type { StreamEvent } from '../src/main/model/types'

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line))
        controller.close()
      },
    }),
    { status: 200 },
  )
}

describe('streamOpenAiResponses', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('转换 input 条目、扁平工具与 reasoning 配置', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)

    for await (const _ of streamOpenAiResponses({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      apiKey: 'sk-test',
      reasoningEffort: 'high',
      maxOutputTokens: 2000,
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '读 a.txt' },
        { role: 'assistant', content: '好的', toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a.txt' } }] },
        { role: 'tool', toolCallId: 'call_1', content: '内容' },
      ],
    })) {
      // 只验证请求体
    }

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' })
    expect(body.max_output_tokens).toBe(2000)
    expect(body.tools).toEqual([
      { type: 'function', name: 'read_file', description: '读文件', parameters: { type: 'object' } },
    ])
    expect(body.input).toEqual([
      { role: 'system', content: [{ type: 'input_text', text: '你是助手' }] },
      { role: 'user', content: [{ type: 'input_text', text: '读 a.txt' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: '好的' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '内容' },
    ])
  })

  it('解析 reasoning summary、function_call 增量与 usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"response.reasoning_summary_text.delta","delta":"先想一下"}\n\n',
          'data: {"type":"response.output_text.delta","delta":"好的"}\n\n',
          'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"write_file"}}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"path\\":"}\n\n',
          'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"\\"a.txt\\"}"}\n\n',
          'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"write_file"}}\n\n',
          'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5,"input_tokens_details":{"cached_tokens":4}}}}\n\n',
        ]),
      ),
    )

    const events: StreamEvent[] = []
    for await (const event of streamOpenAiResponses({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }

    expect(events.filter((event) => event.type === 'reasoning_delta')).toHaveLength(1)
    const text = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => (event.type === 'text_delta' ? event.text : ''))
      .join('')
    expect(text).toBe('好的')
    const toolCall = events.find((event) => event.type === 'tool_call')
    expect(toolCall && toolCall.type === 'tool_call' ? toolCall.call : undefined).toEqual({
      id: 'call_1',
      name: 'write_file',
      input: { path: 'a.txt' },
    })
    const usage = events.find((event) => event.type === 'usage')
    expect(usage && usage.type === 'usage' ? usage.usage : undefined).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 4,
    })
    const done = events.at(-1)
    expect(done && done.type === 'done' ? done.stopReason : undefined).toBe('tool_use')
  })
})
