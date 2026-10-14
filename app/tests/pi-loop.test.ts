/**
 * 新循环测试（R2/R3 之间）：用 faux provider 跑真实 pi `Agent`，断言可离线验证的职责：
 * 事件序列与停止原因、会话双写（用户/助手/工具调用/工具结果/用量）、用量三写、步数上限。
 *
 * 工具是 pi 原生 `AgentTool`（不再有包装器）；不联网、不碰真实文件系统。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../src/main/agent/events'
import { runTurnWithPi, type ModelResolver, type PiLoopDeps } from '../src/main/agent/pi-loop'
import type { NativeTool } from '../src/main/tools/native/tool'

interface SessionItem {
  type: string
  [key: string]: unknown
}

class MemorySessions {
  items: SessionItem[] = []
  touches = 0

  async append(_sessionId: string, item: SessionItem): Promise<void> {
    this.items.push(item)
  }

  async touch(): Promise<void> {
    this.touches += 1
  }

  async loadContextMessages(): Promise<never[]> {
    return []
  }

  async loadOptions(): Promise<{ model?: string }> {
    return { model: undefined }
  }

  of(type: string): SessionItem[] {
    return this.items.filter((item) => item.type === type)
  }
}

function echoTool(executed: string[]): NativeTool {
  return {
    name: 'echo',
    label: '回显',
    description: '回显',
    category: 'read',
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_toolCallId, params) => {
      executed.push(String((params as { text?: string }).text ?? ''))
      return { content: [{ type: 'text' as const, text: 'echo:ok' }], details: { status: 'ok' } }
    },
  }
}

function setup(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux 1' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)

  const sessions = new MemorySessions()
  const executed: string[] = []
  const ledger: unknown[] = []
  const telemetry: unknown[] = []
  const events: AgentEvent[] = []

  const resolver: ModelResolver = {
    resolve: async () => ({
      providerId: 'faux',
      modelId: 'faux-1',
      contextWindow: 100_000,
      model: models.getModel('faux', 'faux-1'),
      streamFn: models.streamSimple.bind(models),
    }),
  }

  const deps: PiLoopDeps = {
    resolver,
    tools: [echoTool(executed)],
    sessions: sessions as unknown as PiLoopDeps['sessions'],
    artifacts: { save: async () => '/tmp/artifact' } as unknown as PiLoopDeps['artifacts'],
    ledger: { record: async (entry: unknown) => void ledger.push(entry) } as unknown as PiLoopDeps['ledger'],
    telemetry: { record: async (entry: unknown) => void telemetry.push(entry) } as unknown as PiLoopDeps['telemetry'],
    permissions: { check: async () => ({ action: 'allow' }) } as unknown as PiLoopDeps['permissions'],
    interactions: {
      requestApproval: async () => 'allow_once',
      requestGuide: async () => '',
    } as unknown as PiLoopDeps['interactions'],
    emit: (event) => void events.push(event),
    workspaceRoot: '/ws',
  }

  return { deps, sessions, executed, ledger, telemetry, events }
}

const options = { sessionId: 's1', userText: '你好', signal: new AbortController().signal }

describe('pi 新循环', () => {
  it('纯文本回合：事件序列完整、助手消息与用量落库、用量三写', async () => {
    const { deps, sessions, executed, ledger, telemetry, events } = setup([fauxAssistantMessage([fauxText('你好呀')])])

    await runTurnWithPi(deps, options)

    expect(events[0].type).toBe('turn.start')
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done' })
    expect(events.some((event) => event.type === 'assistant.delta')).toBe(true)
    expect(events.some((event) => event.type === 'usage.update')).toBe(true)

    expect(sessions.of('message').map((item) => item.role)).toEqual(['user', 'assistant'])
    const assistant = sessions.of('message')[1] as { parts: Array<{ type: string; text?: string }> }
    expect(assistant.parts).toEqual([{ type: 'text', text: '你好呀' }])

    expect(sessions.of('usage')).toHaveLength(1)
    expect(ledger).toHaveLength(1)
    expect(telemetry).toHaveLength(1)
    expect(executed).toEqual([])
  })

  it('工具回合：工具调用与结果双写会话，工具确实执行', async () => {
    const { deps, sessions, executed, events } = setup([
      fauxAssistantMessage([fauxText('先回显'), fauxToolCall('echo', { text: 'hi' })]),
      fauxAssistantMessage([fauxText('完成')]),
    ])

    await runTurnWithPi(deps, options)

    expect(executed).toEqual(['hi'])
    const calls = sessions.of('tool_call')
    const results = sessions.of('tool_result')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ name: 'echo', args: { text: 'hi' } })
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ status: 'ok', output: 'echo:ok' })

    expect(events.some((event) => event.type === 'tool.call')).toBe(true)
    expect(events.some((event) => event.type === 'tool.result')).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done' })
    // 两个助手消息（含工具的与最后的），用量两笔
    expect(sessions.of('message').filter((item) => item.role === 'assistant')).toHaveLength(2)
    expect(sessions.of('usage')).toHaveLength(2)
  })

  it('步数上限：达到 maxSteps 时以 max_steps 结束并写入错误项', async () => {
    const first = setup([
      fauxAssistantMessage([fauxToolCall('echo', { text: 'hi' })]),
      fauxAssistantMessage([fauxText('不该到这里')]),
    ])
    await runTurnWithPi(first.deps, options)
    expect(first.events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done' })
    expect(first.sessions.of('error')).toEqual([])

    const second = setup([fauxAssistantMessage([fauxToolCall('echo', { text: 'hi' })])])
    await runTurnWithPi({ ...second.deps, maxSteps: 1 }, { ...options, sessionId: 's3' })

    expect(second.sessions.of('error').some((item) => item.code === 'MAX_STEPS')).toBe(true)
    expect(second.events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'max_steps' })
  })
})
