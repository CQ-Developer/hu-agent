/** Anthropic Messages API 适配（POST /messages，design 5.9）。
 *
 * 差异：
 * - 鉴权头 x-api-key + anthropic-version；system 是顶层参数而非消息
 * - 思考用 thinking: { type:'enabled', budget_tokens }，流中返回 thinking_delta + signature_delta
 * - 工具结果必须作为 user 消息的 tool_result 内容块，且相邻结果需合并
 * - 使用思考时，工具续轮必须把 thinking 块（含 signature）原样带回
 */

import { ModelError, classifyHttpError, classifyThrown } from '../errors'
import { parseArguments } from './json-args'
import { readSseData } from './sse'
import type { ProviderStreamOptions } from './types'
import type { LlmMessage, StreamEvent } from '../types'
import { t } from '../../i18n'

const API_VERSION = '2023-06-01'

const THINKING_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 16384 }

export async function* streamAnthropicMessages(options: ProviderStreamOptions): AsyncIterable<StreamEvent> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/messages`
  const budget = options.reasoningEffort ? THINKING_BUDGET[options.reasoningEffort] : undefined
  const maxTokens = budget
    ? Math.max(options.maxOutputTokens ?? 4096, budget + 2048)
    : (options.maxOutputTokens ?? 4096)

  const body: Record<string, unknown> = {
    model: options.model,
    max_tokens: maxTokens,
    messages: toAnthropicMessages(options.messages),
    stream: true,
  }
  const system = options.messages
    .filter((message) => message.role === 'system')
    .map((message) => (message.role === 'system' ? message.content : ''))
    .join('\n\n')
  if (system) body.system = system
  if (options.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  if (budget) body.thinking = { type: 'enabled', budget_tokens: budget }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': API_VERSION,
  }
  if (options.apiKey) headers['x-api-key'] = options.apiKey

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

  const toolBlocks = new Map<number, { id?: string; name?: string; args: string }>()
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let sawToolCall = false
  let stopReason: 'stop' | 'tool_use' | 'length' = 'stop'

  for await (const data of readSseData(response)) {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(data) as Record<string, unknown>
    } catch {
      continue
    }

    switch (String(payload.type ?? '')) {
      case 'message_start': {
        const usage = asRecord(asRecord(payload.message).usage)
        inputTokens += Number(usage.input_tokens ?? 0)
        cacheReadTokens += Number(usage.cache_read_input_tokens ?? 0)
        cacheWriteTokens += Number(usage.cache_creation_input_tokens ?? 0)
        break
      }
      case 'content_block_start': {
        const index = Number(payload.index ?? 0)
        const block = asRecord(payload.content_block)
        if (block.type === 'tool_use') {
          toolBlocks.set(index, {
            id: typeof block.id === 'string' ? block.id : undefined,
            name: typeof block.name === 'string' ? block.name : undefined,
            args: '',
          })
        }
        break
      }
      case 'content_block_delta': {
        const delta = asRecord(payload.delta)
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          yield { type: 'text_delta', text: delta.text }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          yield { type: 'reasoning_delta', text: delta.thinking }
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          yield { type: 'reasoning_delta', text: '', signatureDelta: delta.signature }
        } else if (delta.type === 'input_json_delta') {
          const entry = toolBlocks.get(Number(payload.index ?? 0))
          if (entry && typeof delta.partial_json === 'string') entry.args += delta.partial_json
        }
        break
      }
      case 'content_block_stop': {
        const index = Number(payload.index ?? 0)
        const entry = toolBlocks.get(index)
        if (entry) {
          sawToolCall = true
          yield {
            type: 'tool_call',
            call: {
              id: entry.id ?? `call_${index}`,
              name: entry.name ?? 'unknown',
              input: parseArguments(entry.args),
            },
          }
          toolBlocks.delete(index)
        }
        break
      }
      case 'message_delta': {
        outputTokens = Number(asRecord(payload.usage).output_tokens ?? outputTokens)
        const reason = asRecord(payload.delta).stop_reason
        if (reason === 'max_tokens') stopReason = 'length'
        break
      }
      case 'error': {
        throw new ModelError('server', t('Anthropic API 错误：{0}', { 0: JSON.stringify(payload).slice(0, 500) }))
      }
      default:
        break
    }
  }

  yield {
    type: 'usage',
    usage: {
      // Anthropic 的 input_tokens 不含缓存部分，这里统一为总输入
      inputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    },
  }
  yield { type: 'done', stopReason: sawToolCall ? 'tool_use' : stopReason }
}

function toAnthropicMessages(messages: LlmMessage[]): unknown[] {
  const out: unknown[] = []
  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }
      const last = out.at(-1) as { role?: string; content?: unknown[] } | undefined
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every(isToolResult)) {
        last.content.push(block)
      } else {
        out.push({ role: 'user', content: [block] })
      }
      continue
    }

    if (message.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: message.content }] })
      continue
    }

    const content: unknown[] = []
    if (message.reasoning?.text && message.reasoning.signature) {
      content.push({ type: 'thinking', thinking: message.reasoning.text, signature: message.reasoning.signature })
    }
    if (message.content) content.push({ type: 'text', text: message.content })
    for (const call of message.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} })
    }
    if (content.length > 0) out.push({ role: 'assistant', content })
  }
  return out
}

function isToolResult(block: unknown): boolean {
  return typeof block === 'object' && block !== null && (block as { type?: string }).type === 'tool_result'
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
