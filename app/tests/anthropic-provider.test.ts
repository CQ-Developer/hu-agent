/** Anthropic Messages API 适配单测（请求体转换 + SSE 事件解析 + thinking 签名）。 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamAnthropicMessages } from '../src/main/model/providers/anthropic'
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

describe('streamAnthropicMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('转换 system / 合并 tool_result / 思考预算与签名回放', async () => {
    const fetchMock = vi.fn(async () => sseResponse([]))
    vi.stubGlobal('fetch', fetchMock)

    for await (const _ of streamAnthropicMessages({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-ant',
      reasoningEffort: 'medium',
      maxOutputTokens: 4096,
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }],
      messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '读 a.txt' },
        {
          role: 'assistant',
          content: '',
          reasoning: { text: '我在想', signature: 'sig-1' },
          toolCalls: [{ id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } }],
        },
        { role: 'tool', toolCallId: 'toolu_1', content: '内容1' },
        { role: 'tool', toolCallId: 'toolu_2', content: '内容2' },
      ],
    })) {
      // 只验证请求体
    }

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant')
    expect(headers['anthropic-version']).toBe('2023-06-01')

    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body.system).toBe('你是助手')
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(body.max_tokens).toBe(10240) // budget + 2048
    expect(body.tools).toEqual([{ name: 'read_file', description: '读文件', input_schema: { type: 'object' } }])
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '读 a.txt' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '我在想', signature: 'sig-1' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.txt' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '内容1' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: '内容2' },
        ],
      },
    ])
  })

  it('解析 thinking / signature / tool_use / usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先想"}}\n\n',
          'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}\n\n',
          'data: {"type":"content_block_stop","index":0}\n\n',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"好的"}}\n\n',
          'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"bash"}}\n\n',
          'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
          'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}\n\n',
          'data: {"type":"content_block_stop","index":2}\n\n',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      ),
    )

    const events: StreamEvent[] = []
    for await (const event of streamAnthropicMessages({
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      events.push(event)
    }

    const reasoningText = events
      .filter((event) => event.type === 'reasoning_delta')
      .map((event) => (event.type === 'reasoning_delta' ? event.text : ''))
      .join('')
    expect(reasoningText).toBe('先想')
    const signature = events
      .filter((event) => event.type === 'reasoning_delta')
      .map((event) => (event.type === 'reasoning_delta' ? event.signatureDelta : ''))
      .join('')
    expect(signature).toBe('sig-abc')

    const toolCall = events.find((event) => event.type === 'tool_call')
    expect(toolCall && toolCall.type === 'tool_call' ? toolCall.call : undefined).toEqual({
      id: 'toolu_1',
      name: 'bash',
      input: { command: 'ls' },
    })

    const usage = events.find((event) => event.type === 'usage')
    expect(usage && usage.type === 'usage' ? usage.usage : undefined).toMatchObject({
      inputTokens: 15,
      outputTokens: 7,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    })

    const done = events.at(-1)
    expect(done && done.type === 'done' ? done.stopReason : undefined).toBe('tool_use')
  })
})
