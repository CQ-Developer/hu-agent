/** 历史压缩单测（design 5.2.3）：摘要写入、上下文应用与降级。 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { compactHistory, estimateTokens } from '../src/main/agent/compaction'
import { runTurn } from '../src/main/agent/loop'
import type { InteractionBroker } from '../src/main/permissions/broker'
import type { PermissionEngine } from '../src/main/permissions/engine'
import { ModelGateway } from '../src/main/model/gateway'
import type { LlmMessage, StreamEvent } from '../src/main/model/types'
import { ArtifactStore } from '../src/main/session/artifacts'
import { SessionStore } from '../src/main/session/store'
import { createDefaultToolRegistry } from '../src/main/tools/registry'
import { UsageLedger } from '../src/main/usage/ledger'
import type { AgentEvent } from '../src/shared/events'

const permissions = { check: async () => ({ action: 'allow' as const }) } as unknown as PermissionEngine
const interactions = {} as unknown as InteractionBroker

/** 记录每次调用入参的假网关。 */
function recordingGateway(script: StreamEvent[][]): { gateway: ModelGateway; calls: LlmMessage[][] } {
  const calls: LlmMessage[][] = []
  let index = 0
  const gateway = {
    resolve: () => ({
      provider: { id: 'fake', apiType: 'openai-chat', baseUrl: 'http://fake', apiKeyRef: null, models: [] },
      model: { name: 'fake-fast', capabilities: { tools: true, contextWindow: 100 } },
    }),
    chat: (_request: unknown, messages: LlmMessage[]) => {
      calls.push(messages)
      const events = script[Math.min(index, script.length - 1)] ?? []
      index += 1
      return (async function* generate(): AsyncGenerator<StreamEvent> {
        for (const event of events) yield event
      })()
    },
  } as unknown as ModelGateway
  return { gateway, calls }
}

describe('历史压缩', () => {
  let root: string
  let sessions: SessionStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huagent-compact-'))
    sessions = new SessionStore(join(root, '.hu', 'sessions'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('estimateTokens 按字符估算', () => {
    expect(estimateTokens([{ role: 'user', content: 'a'.repeat(400) }])).toBe(100)
  })

  it('compactHistory 写入 summary 行并记录 fast 用量', async () => {
    const meta = await sessions.create()
    for (let index = 0; index < 12; index += 1) {
      await sessions.append(meta.id, {
        type: 'message',
        id: `m${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `第 ${index} 条历史消息` }],
        createdAt: new Date().toISOString(),
      })
    }

    const { gateway } = recordingGateway([
      [
        { type: 'text_delta', text: '摘要：用户在做一件事。' },
        { type: 'usage', usage: { inputTokens: 50, outputTokens: 10 } },
        { type: 'done', stopReason: 'stop' },
      ],
    ])
    const ledger = new UsageLedger(join(root, '.hu', 'usage.jsonl'))

    const ok = await compactHistory(
      { gateway, sessions, ledger, fastTarget: 'fake/fake-fast', keepRecentMessages: 8 },
      meta.id,
      new AbortController().signal,
    )
    expect(ok).toBe(true)

    const { lines } = await sessions.readLines(meta.id)
    const summary = lines.find((line) => line.type === 'summary')
    expect(summary && summary.type === 'summary' ? summary.text : '').toContain('摘要')
    const usage = lines.find((line) => line.type === 'usage')
    expect(usage && usage.type === 'usage' ? usage.purpose : undefined).toBe('fast')

    // 带摘要的上下文只保留最近 8 条消息 + 摘要系统消息
    const context = await sessions.loadContextMessages(meta.id)
    expect(context[0]?.role).toBe('system')
    expect(context[0]?.content).toContain('摘要')
    expect(context).toHaveLength(9)
  })

  it('消息不足保留条数时不压缩', async () => {
    const meta = await sessions.create()
    await sessions.append(meta.id, {
      type: 'message',
      id: 'm1',
      role: 'user',
      parts: [{ type: 'text', text: '只有一条' }],
      createdAt: new Date().toISOString(),
    })
    const { gateway } = recordingGateway([[]])
    const ok = await compactHistory(
      { gateway, sessions, ledger: new UsageLedger(join(root, '.hu', 'usage.jsonl')), fastTarget: 'fake/fake-fast' },
      meta.id,
      new AbortController().signal,
    )
    expect(ok).toBe(false)
  })

  it('Agent Loop 在上下文超阈值时压缩，并用摘要继续对话', async () => {
    const meta = await sessions.create()
    for (let index = 0; index < 12; index += 1) {
      await sessions.append(meta.id, {
        type: 'message',
        id: `h${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: '历史内容'.repeat(30) }],
        createdAt: new Date().toISOString(),
      })
    }

    const { gateway, calls } = recordingGateway([
      [
        { type: 'text_delta', text: '压缩后的摘要' },
        { type: 'usage', usage: { inputTokens: 30, outputTokens: 8 } },
        { type: 'done', stopReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: '这是最终回答' },
        { type: 'usage', usage: { inputTokens: 20, outputTokens: 5 } },
        { type: 'done', stopReason: 'stop' },
      ],
    ])

    const events: AgentEvent[] = []
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
        fastTarget: 'fake/fake-fast',
      },
      { sessionId: meta.id, userText: '继续', signal: new AbortController().signal },
    )

    // 压缩调用 + 正式回答调用
    expect(calls).toHaveLength(2)
    const finalCall = calls[1] ?? []
    expect(finalCall[0]?.role).toBe('system')
    expect(finalCall[1]?.content).toContain('摘要')
    expect(events.some((event) => event.type === 'session.compacted')).toBe(true)
    expect(events.at(-1)?.type).toBe('turn.end')

    const summary = (await sessions.readLines(meta.id)).lines.find((line) => line.type === 'summary')
    expect(summary).toBeTruthy()
  })
})
