/**
 * 回合运行器装配测试（R3）。
 *
 * 用 faux provider 注入 pi 的 models 集合，断言"一次替换即可切换引擎"所需的全部接线：
 * 事件出口、会话双写、用量三写、工具执行、刷新入口。
 * 不联网、不碰真实文件系统与真实密钥库。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../src/main/agent/events'
import { createPiTurnRunner, type PiRunnerOptions } from '../src/main/agent/pi_runner'

interface SessionItem {
  type: string
  [key: string]: unknown
}

class MemorySessions {
  items: SessionItem[] = []

  async append(_sessionId: string, item: SessionItem): Promise<void> {
    this.items.push(item)
  }

  async touch(): Promise<void> {}

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

async function runner() {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux 1', contextWindow: 64_000 }] })
  const models = createModels()
  models.setProvider(faux.provider)

  const sessions = new MemorySessions()
  const ledger: unknown[] = []
  const telemetry: unknown[] = []
  const agentDir = await mkdtemp(join(tmpdir(), 'huagent-runner-'))

  const options: PiRunnerOptions = {
    workspaceRoot: agentDir,
    getSecret: () => null,
    permissions: { check: async () => ({ action: 'allow' }) } as never,
    interactions: {
      requestApproval: async () => 'allow_once',
      requestGuide: async () => '',
      askGuide: async () => '',
    } as never,
    sessions: sessions as never,
    artifacts: { save: async () => '/tmp/artifact' } as never,
    ledger: { record: async (entry: unknown) => void ledger.push(entry) } as never,
    telemetry: { record: async (entry: unknown) => void telemetry.push(entry) } as never,
    agentDir,
    models,
  }

  return { runner: createPiTurnRunner(options), faux, sessions, ledger, telemetry }
}

describe('回合运行器（IPC 只需依赖一个函数签名）', () => {
  it('一次 runTurn：事件出口、助手消息、用量三写都到位', async () => {
    const { runner, faux, sessions, ledger, telemetry } = await runner()
    faux.setResponses([fauxAssistantMessage([fauxText('你好呀')])])

    const events: AgentEvent[] = []
    await runner.runTurn({
      sessionId: 's1',
      userText: '你好',
      signal: new AbortController().signal,
      emit: (event) => void events.push(event),
    })

    expect(events[0].type).toBe('turn.start')
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done' })
    expect(events.some((event) => event.type === 'assistant.delta')).toBe(true)

    expect(sessions.of('message').map((item) => item.role)).toEqual(['user', 'assistant'])
    expect(sessions.of('usage')).toHaveLength(1)
    expect(ledger).toHaveLength(1)
    expect(telemetry).toHaveLength(1)
  })

  it('工具回合：默认工具集可被模型调用（write_file 真写盘）', async () => {
    const { runner, faux, sessions } = await runner()
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'note.txt', content: 'hi' })]),
      fauxAssistantMessage([fauxText('写好了')]),
    ])

    const events: AgentEvent[] = []
    await runner.runTurn({
      sessionId: 's2',
      userText: '写个文件',
      signal: new AbortController().signal,
      emit: (event) => void events.push(event),
    })

    expect(sessions.of('tool_call')).toHaveLength(1)
    expect(sessions.of('tool_result')[0]).toMatchObject({ status: 'ok' })
    expect(events.some((event) => event.type === 'tool.result')).toBe(true)
  })

  it('refresh() 可在设置变更后重新注册 provider', async () => {
    const { runner } = await runner()
    await expect(runner.refresh()).resolves.toBeUndefined()
  })
})
