/** OpenAI Responses API 适配（POST /responses，design 5.9）。
 *
 * 与 Chat Completions 的差异：
 * - 输入是 input 条目数组（input_text / output_text / function_call / function_call_output）
 * - 工具定义是扁平的 {type:'function', name, description, parameters}
 * - 思考内容通过 reasoning summary 流返回；推理强度用 reasoning: { effort }
 */

import { ModelError, classifyHttpError, classifyThrown } from '../errors'
import { parseArguments } from './json-args'
import { readSseData } from './sse'
import type { ProviderStreamOptions } from './types'
import type { LlmMessage, StreamEvent } from '../types'

export async function* streamOpenAiResponses(options: ProviderStreamOptions): AsyncIterable<StreamEvent> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/responses`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`

  const body: Record<string, unknown> = {
    model: options.model,
    input: toResponsesInput(options.messages),
    stream: true,
  }
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }
  if (options.maxOutputTokens) body.max_output_tokens = options.maxOutputTokens
  if (options.reasoningEffort) body.reasoning = { effort: options.reasoningEffort, summary: 'auto' }

  let response: Response
  try {
    response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: options.signal })
  } catch (error) {
    throw classifyThrown(error)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw classifyHttpError(response.status, text)
  }

  const pending = new Map<string, { callId?: string; name?: string; args: string }>()
  let sawToolCall = false
  let stopReason: 'stop' | 'length' = 'stop'

  for await (const data of readSseData(response)) {
    if (data === '[DONE]') break
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }

    switch (String(payload.type ?? '')) {
      case 'response.output_text.delta': {
        if (typeof payload.delta === 'string' && payload.delta) {
          yield { type: 'text_delta', text: payload.delta }
        }
        break
      }
      case 'response.reasoning_summary_text.delta':
      // DeepSeek 等兼容实现使用 reasoning_text.delta（内容等价）
      case 'response.reasoning_text.delta': {
        if (typeof payload.delta === 'string' && payload.delta) {
          yield { type: 'reasoning_delta', text: payload.delta }
        }
        break
      }
      case 'response.output_item.added': {
        const item = asRecord(payload.item)
        if (item.type === 'function_call') {
          pending.set(String(item.id), {
            callId: typeof item.call_id === 'string' ? item.call_id : undefined,
            name: typeof item.name === 'string' ? item.name : undefined,
            args: '',
          })
        }
        break
      }
      case 'response.function_call_arguments.delta': {
        const entry = pending.get(String(payload.item_id))
        if (entry && typeof payload.delta === 'string') entry.args += payload.delta
        break
      }
      case 'response.output_item.done': {
        const item = asRecord(payload.item)
        if (item.type === 'function_call') {
          const entry = pending.get(String(item.id))
          sawToolCall = true
          yield {
            type: 'tool_call',
            call: {
              id: entry?.callId ?? (typeof item.call_id === 'string' ? item.call_id : `call_${pending.size}`),
              name: entry?.name ?? (typeof item.name === 'string' ? item.name : 'unknown'),
              input: parseArguments(entry?.args ?? (typeof item.arguments === 'string' ? item.arguments : undefined)),
            },
          }
          pending.delete(String(item.id))
        }
        break
      }
      case 'response.completed': {
        const completed = asRecord(payload.response)
        if (completed.status === 'incomplete') stopReason = 'length'
        const usage = asRecord(completed.usage)
        if (Object.keys(usage).length > 0) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: Number(usage.input_tokens ?? 0),
              outputTokens: Number(usage.output_tokens ?? 0),
              cacheReadTokens: Number(asRecord(usage.input_tokens_details).cached_tokens ?? 0),
            },
          }
        }
        break
      }
      case 'response.failed':
      case 'error': {
        throw new ModelError('server', `Responses API 错误：${JSON.stringify(payload).slice(0, 500)}`)
      }
      default:
        break
    }
  }

  yield { type: 'done', stopReason: sawToolCall ? 'tool_use' : stopReason }
}

function toResponsesInput(messages: LlmMessage[]): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      input.push({ role: 'system', content: [{ type: 'input_text', text: message.content }] })
    } else if (message.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] })
    } else if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output: message.content })
    } else {
      if (message.content) {
        input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] })
      }
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        })
      }
    }
  }
  return input
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
