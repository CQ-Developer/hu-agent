import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runTurn } from '../src/main/agent/loop'
import type { InteractionBroker } from '../src/main/permissions/broker'
import type { PermissionEngine } from '../src/main/permissions/engine'
import type { ModelGateway } from '../src/main/model/gateway'
import type { StreamEvent } from '../src/main/model/types'
import { ArtifactStore } from '../src/main/session/artifacts'
import { SessionStore } from '../src/main/session/store'
import { createDefaultToolRegistry } from '../src/main/tools/registry'
import { UsageLedger } from '../src/main/usage/ledger'
import type { AgentEvent } from '../src/shared/events'

const permissions = { check: async () => ({ action: 'allow' as const }) } as unknown as PermissionEngine
const interactions = {} as unknown as InteractionBroker

/** 脚本化假模型：按调用次数依次播放预设事件流。 */
function fakeGateway(script: StreamEvent[][]): ModelGateway {
  let call = 0
  return {
    resolve: () => ({
      provider: { id: 'fake', type: 'openai-compatible', baseUrl: 'http://fake', apiKeyRef: null, models: [] },
      model: { name: 'fake-model', capabilities: { tools: true, contextWindow: 8192 } },
    }),
    chat: () => {
      const events = script[Math.min(call, script.length - 1)] ?? []
      call += 1
      return (async function* generate(): AsyncGenerator<StreamEvent> {
        for (const event of events) yield event
      })()
    },
  } as unknown as ModelGateway
}

describe('Agent Loop 冒烟', () => {
  let root: string
  let sessions: SessionStore
  let events: AgentEvent[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huagent-loop-'))
    sessions = new SessionStore(join(root, '.hu', 'sessions'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('模型调用工具后继续，直至无工具调用并写入会话与账本', async () => {
    const gateway = fakeGateway([
      [
        { type: 'reasoning_delta', text: '先想一下：' },
        { type: 'text_delta', text: '我来写入文件。' },
        {
          type: 'tool_call',
          call: { id: 'call_1', name: 'write_file', input: { path: 'notes.txt', content: 'hello' } },
        },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 30 } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '已完成。' },
        { type: 'usage', usage: { inputTokens: 150, outputTokens: 10 } },
        { type: 'done', stopReason: 'stop' },
      ],
    ])

    const meta = await sessions.create('冒烟')
    events = []
    const ledger = new UsageLedger(join(root, '.hu', 'usage.jsonl'))

    await runTurn(
      {
        gateway,
        tools: createDefaultToolRegistry(),
        sessions,
        artifacts: new ArtifactStore(join(root, '.hu', 'sessions', 'artifacts')),
        ledger,
        permissions,
        interactions,
        emit: (event) => events.push(event),
        workspaceRoot: root,
      },
      { sessionId: meta.id, userText: '写一个 notes.txt', signal: new AbortController().signal },
    )

    // 工具真实执行了
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('hello')

    // 会话 JSONL 行类型完整
    const { lines, corrupted } = await sessions.readLines(meta.id)
    expect(corrupted).toBe(0)
    const types = lines.map((line) => line.type)
    expect(types).toEqual(['meta', 'message', 'usage', 'message', 'tool_call', 'tool_result', 'usage', 'message'])
    const toolResult = lines.find((line) => line.type === 'tool_result')
    expect(toolResult && toolResult.type === 'tool_result' ? toolResult.status : undefined).toBe('ok')

    // 思考内容作为独立的 reasoning 部分落盘（design 5.3.2）
    const firstAssistant = lines.find((line) => line.type === 'message' && line.role === 'assistant')
    const partTypes = firstAssistant?.type === 'message' ? firstAssistant.parts.map((part) => part.type) : []
    expect(partTypes).toEqual(['reasoning', 'text'])

    // 事件流顺序
    expect(events[0]?.type).toBe('turn.start')
    expect(events.some((event) => event.type === 'tool.call')).toBe(true)
    expect(events.some((event) => event.type === 'tool.result')).toBe(true)
    const end = events.at(-1)
    expect(end?.type === 'turn.end' ? end.stopReason : undefined).toBe('done')

    // 两次模型调用各记一笔账
    const stats = await ledger.stats()
    expect(stats.calls).toBe(2)
    expect(stats.inputTokens).toBe(250)
    expect(stats.outputTokens).toBe(40)
  })

  it('取消时结束原因为 cancelled', async () => {
    const controller = new AbortController()
    const gateway = fakeGateway([[]])
    gateway.chat = (() => {
      return (async function* generate(): AsyncGenerator<StreamEvent> {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      })()
    }) as unknown as ModelGateway['chat']

    const meta = await sessions.create()
    events = []
    await runTurn(
      {
        gateway,
        tools: createDefaultToolRegistry(),
        sessions,
        artifacts: new ArtifactStore(join(root, '.hu', 'sessions', 'artifacts')),
        ledger: new UsageLedger(join(root, '.hu', 'usage.jsonl')),
        permissions,
        interactions,
        emit: (event) => events.push(event),
        workspaceRoot: root,
      },
      { sessionId: meta.id, userText: '随便', signal: controller.signal },
    )

    const end = events.at(-1)
    expect(end?.type === 'turn.end' ? end.stopReason : undefined).toBe('cancelled')
  })
})
