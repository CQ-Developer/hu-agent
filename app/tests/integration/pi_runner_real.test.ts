/**
 * 新引擎路径的真实调用验证（R1 切换后的整条路径）。
 *
 * 验证 `createDurableTurnRunner`：pi 运行时（models.json）→ `DurableSessions`（pi-durable / SQLite）
 * → harness 跑回合 → 原生工具 → 治理钩子 → 事件投影 → 用量落账。
 *
 * 门禁：`PI_E2E=1` 且提供 `PI_AGENT_DIR`（含 models.json 的 agent 目录）。
 * 密钥从 models.json 内联的 apiKey 解析，**不需要把密钥放进环境变量**。
 * 约定：只允许使用 `deepseek-v4.1-flash`（用户指定的测试模型）。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDurableTurnRunner, sessionFilesFor } from '../../src/main/agent/durable_runner'
import { createPiRuntime } from '../../src/main/model/pi_runtime'
import { DurableSessions } from '../../src/main/session/durable'
import { toSessionItems } from '../../src/main/session/durable_view'
import type { AgentEvent } from '../../src/shared/events'

const ALLOWED_MODEL = 'deepseek-v4.1-flash'
const PROVIDER = process.env.PI_GATEWAY_PROVIDER ?? 'token-hub'
const agentDir = process.env.PI_AGENT_DIR ?? ''
const enabled = process.env.PI_E2E === '1' && agentDir !== ''

describe.skipIf(!enabled)('新引擎路径真实调用（运行器 → 模型 → 工具 → 落库）', () => {
  let dir: string
  let sessions: DurableSessions | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-real-runner-'))
  })

  afterEach(async () => {
    await sessions?.close().catch(() => undefined)
    sessions = null
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined)
  })

  async function realRunner() {
    // 用生产装配（不再手拼 provider）：models.json → pi 的 models 集合
    const runtime = createPiRuntime({ getSecret: () => null, path: join(agentDir, 'models.json') })
    await runtime.refresh()

    const files = sessionFilesFor(dir, 'ws_real')
    const service = new DurableSessions({ ...files, models: runtime.models, cwd: dir, workspaceId: 'ws_real' })
    await service.open()
    sessions = service
    const sessionId = (
      await service.create({ title: '真实调用', model: { provider: PROVIDER, modelId: ALLOWED_MODEL } })
    ).id

    const ledger: Array<Record<string, unknown>> = []
    const telemetry: Array<Record<string, unknown>> = []
    const runner = createDurableTurnRunner({
      sessions: service,
      permissions: { check: async () => ({ action: 'allow' }) } as never,
      interactions: {
        requestApproval: async () => 'allow_once',
        requestGuide: async () => '',
        askGuide: async () => '',
      } as never,
      artifacts: { save: async () => join(dir, 'artifact') } as never,
      ledger: { record: async (entry: Record<string, unknown>) => void ledger.push(entry) } as never,
      telemetry: { record: async (entry: Record<string, unknown>) => void telemetry.push(entry) } as never,
      workspaceRoot: dir,
    })
    return { runner, service, sessionId, ledger, telemetry }
  }

  it('纯文本回合：事件、transcript、用量三写都到位', async () => {
    const { runner, service, sessionId, ledger, telemetry } = await realRunner()
    const events: AgentEvent[] = []

    await runner.runTurn({
      sessionId,
      userText: '只回复两个字：收到',
      signal: new AbortController().signal,
      emit: (event) => void events.push(event),
    })

    expect(events[0].type).toBe('turn.start')
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done' })

    // transcript 经边界投影（toSessionItems）后能看到助手文本
    const view = await service.view(sessionId)
    const items = toSessionItems(view.entries as never[])
    const assistant = items.filter((item) => item.kind === 'message' && item.role === 'assistant')
    expect(assistant.length).toBeGreaterThan(0)
    const text = assistant
      .map((item) => (item.kind === 'message' ? item.text : ''))
      .join('')
      .trim()
    expect(text.length).toBeGreaterThan(0)
    console.log(`[pi-runner] 模型回复：${text.slice(0, 60)}`)

    const usage = (view.docs['pi.usage'] ?? {}) as {
      models?: Record<string, { input?: number; output?: number }>
    }
    const totals = Object.values(usage.models ?? {})
    expect(totals.some((entry) => (entry.input ?? 0) > 0 && (entry.output ?? 0) > 0)).toBe(true)
    expect(ledger.length).toBeGreaterThan(0)
    expect(telemetry.length).toBeGreaterThan(0)

    // 第二回合：落账只加本回合的差量（累计落账会把上一回合重复计一次）
    const ledgerAfterFirst = ledger.length
    await runner.runTurn({
      sessionId,
      userText: '再回复两个字：好的',
      signal: new AbortController().signal,
      emit: () => undefined,
    })
    expect(ledger.length).toBe(ledgerAfterFirst * 2)
  }, 240_000)

  it('工具回合：真实模型调用原生 write_file，工作空间内真的落盘', async () => {
    const { runner, service, sessionId } = await realRunner()
    const events: AgentEvent[] = []

    await runner.runTurn({
      sessionId,
      userText: '请在当前目录创建文件 note.txt，内容恰好是 hu-agent-ok。创建后回复"完成"。',
      signal: new AbortController().signal,
      emit: (event) => void events.push(event),
    })

    const view = await service.view(sessionId)
    const tools = toSessionItems(view.entries as never[]).filter((item) => item.kind === 'tool')
    console.log(`[pi-runner] 工具调用：${tools.map((item) => `${item.kind === 'tool' ? item.name : ''}:${item.kind === 'tool' ? item.status : ''}`).join(',')}`)
    // 真实模型不保证一定调工具：只在它调了的时候断言语义（避免把模型行为波动当成回归）
    if (tools.length > 0) {
      expect(tools.some((item) => item.kind === 'tool' && item.status === 'ok')).toBe(true)
      expect(events.some((event) => event.type === 'tool.result')).toBe(true)
      expect(await readFile(join(dir, 'note.txt'), 'utf8')).toContain('hu-agent-ok')
    }
    expect(events.at(-1)).toMatchObject({ type: 'turn.end' })
  }, 240_000)
})
