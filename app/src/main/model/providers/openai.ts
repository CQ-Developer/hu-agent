/** OpenAI 兼容协议适配：/chat/completions 流式 + function calling。
 *
 * 覆盖 OpenAI、Azure OpenAI、vLLM、Ollama、DeepSeek 等 OpenAI 兼容服务（design 5.9）。
 */

import { ModelError, classifyHttpError, classifyThrown } from '../errors'
import type { LlmMessage, StreamEvent, ToolCall, ToolDefinitionForModel } from '../types'

export interface OpenAiChatOptions {
  baseUrl: string
  model: string
  messages: LlmMessage[]
  tools?: ToolDefinitionForModel[]
  apiKey?: string | null
  signal?: AbortSignal
  maxOutputTokens?: number
}

interface DeltaToolCall {
  /** OpenAI 协议通常带 index；部分兼容服务省略，按数组位置回退 */
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

/** 流式工具调用的累积状态（name/arguments 分块到达）。 */
interface PendingToolCall {
  index: number
  id?: string
  name?: string
  argumentsText?: string
}

function toOpenAiMessages(messages: LlmMessage[]): Record<string, unknown>[] {
  return messages.map((message) => {
    if (message.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content: message.content || null }
      if (message.toolCalls?.length) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        }))
      }
      return out
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    }
    return { role: message.role, content: message.content }
  })
}

export async function* streamOpenAiChat(options: OpenAiChatOptions): AsyncIterable<StreamEvent> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`

  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(options.messages),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({ type: 'function', function: tool }))
  }
  if (options.maxOutputTokens) body.max_tokens = options.maxOutputTokens

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    })
  } catch (error) {
    throw classifyThrown(error)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw classifyHttpError(response.status, text)
  }
  if (!response.body) throw new ModelError('server', '模型服务返回空响应体')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const pendingToolCalls = new Map<number, PendingToolCall>()
  let buffer = ''
  let stopReason: 'stop' | 'tool_use' | 'length' = 'stop'
  let sawToolCall = false

  const handleChunk = (payload: Record<string, unknown>): StreamEvent[] => {
    const events: StreamEvent[] = []
    const choices = (payload.choices as Record<string, unknown>[] | undefined) ?? []
    const choice = choices[0]
    if (choice) {
      const delta = (choice.delta as Record<string, unknown> | undefined) ?? {}
      const content = delta.content
      if (typeof content === 'string' && content.length > 0) events.push({ type: 'text_delta', text: content })
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        events.push({ type: 'reasoning_delta', text: reasoning })
      }
      const toolCalls = delta.tool_calls as DeltaToolCall[] | undefined
      if (toolCalls?.length) {
        sawToolCall = true
        toolCalls.forEach((partial, position) => {
          const key = partial.index ?? position
          const current = pendingToolCalls.get(key) ?? { index: key }
          if (partial.id) current.id = partial.id
          if (partial.function?.name) current.name = partial.function.name
          if (partial.function?.arguments) {
            current.argumentsText = (current.argumentsText ?? '') + partial.function.arguments
          }
          pendingToolCalls.set(key, current)
        })
      }
      const finish = choice.finish_reason
      if (finish === 'length') stopReason = 'length'
      if (finish === 'tool_calls') stopReason = 'tool_use'
    }
    const usage = payload.usage as Record<string, unknown> | undefined
    if (usage) {
      events.push({
        type: 'usage',
        usage: {
          inputTokens: Number(usage.prompt_tokens ?? 0),
          outputTokens: Number(usage.completion_tokens ?? 0),
          cacheReadTokens: Number((usage.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ?? 0),
        },
      })
    }
    return events
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      newlineIndex = buffer.indexOf('\n')
      if (line.length === 0 || line.startsWith(':')) continue
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        for (const call of finalizeToolCalls(pendingToolCalls)) yield { type: 'tool_call', call }
        yield { type: 'done', stopReason: sawToolCall ? 'tool_use' : stopReason }
        return
      }
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(data) as Record<string, unknown>
      } catch {
        continue // 忽略无法解析的心跳/片段
      }
      for (const event of handleChunk(payload)) yield event
    }
  }

  for (const call of finalizeToolCalls(pendingToolCalls)) yield { type: 'tool_call', call }
  yield { type: 'done', stopReason: sawToolCall ? 'tool_use' : stopReason }
}

function finalizeToolCalls(pending: Map<number, PendingToolCall>): ToolCall[] {
  return [...pending.entries()]
    .sort(([left], [right]) => left - right)
    .map(([key, partial], index) => ({
      id: partial.id ?? `call_${key}_${index}`,
      name: partial.name ?? 'unknown',
      input: parseArguments(partial.argumentsText),
    }))
}

function parseArguments(text: string | undefined): unknown {
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}
