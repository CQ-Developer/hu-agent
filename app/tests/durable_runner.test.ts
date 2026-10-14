/**
 * 新运行器测试（R1 最终形态）：会话服务（pi-durable）+ durable 回环。
 * 无旧形状参与（没有 SessionStore／resolver／summarizer）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDurableTurnRunner, sessionFilesFor } from '../src/main/agent/durable_runner'
import { DurableSessions } from '../src/main/session/durable'
import type { AgentEvent } from '../src/shared/events'

const MODEL = 'faux-1'

describe('durable 运行器', () => {
  let dir: string
  let sessions: DurableSessions | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-runner-'))
  })

  afterEach(async () => {
    await sessions?.close().catch(() => undefined)
    sessions = null
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined)
  })

  async function setup() {
    const faux = fauxProvider({ models: [{ id: MODEL, name: 'Faux 1' }] })
    const models = createModels()
    models.setProvider(faux.provider)
    faux.setResponses([fauxAssistantMessage([fauxText('你好呀')])])

    const files = sessionFilesFor(dir, 'ws_1')
    const service = new DurableSessions({ ...files, models, cwd: dir, workspaceId: 'ws_1' })
    await service.open()
    sessions = service
    const sessionId = await service.create({ title: '运行器测试', model: { provider: 'faux', modelId: MODEL } })

    const events: AgentEvent[] = []
    const ledger: unknown[] = []
    const runner = createDurableTurnRunner({
      sessions: service,
      permissions: { check: async () => ({ action: 'allow' }) } as never,
      interactions: { requestApproval: async () => 'allow_once', requestGuide: async () => '' } as never,
      artifacts: { save: async () => join(dir, 'artifact') } as never,
      ledger: { record: async (entry: unknown) => void ledger.push(entry) } as never,
      workspaceRoot: dir,
    })
    return { runner, service, sessionId, events, ledger }
  }

  it('一次回合：事件落地、会话写进 pi-durable、投影用的 provider/model 来自会话配置', async () => {
    const { runner, service, sessionId } = await setup()
    const events: AgentEvent[] = []

    await runner.runTurn({
      sessionId,
      userText: '你好',
      signal: new AbortController().signal,
      emit: (event) => void events.push(event),
    })

    expect(events[0]).toMatchObject({ type: 'turn.start', sessionId })
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done', sessionId })

    const view = await service.view(sessionId)
    expect(view.entries).toBeDefined()
    expect(view.docs['pi.usage']).toBeDefined()
  }, 60_000)

  it('会话文件按工作空间隔离（每个工作空间一份 SQLite + 索引）', () => {
    const a = sessionFilesFor('/root', 'ws_a')
    const b = sessionFilesFor('/root', 'ws_b')
    expect(a.file).not.toBe(b.file)
    expect(a.file.endsWith(join('sessions', 'ws_a.sqlite'))).toBe(true)
    expect(a.indexFile.endsWith(join('sessions', 'ws_a.index.json'))).toBe(true)
  })
})
