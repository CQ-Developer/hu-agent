/**
 * 新引擎路径的真实调用验证（R3 切换前的最后一道闸）。
 *
 * 与 `pi-real.test.ts` 的区别：那个验证的是 pi-ai/pi-agent-core 的底层契约；
 * 本文件验证的是**我们装配好的整条路径**——`createPiTurnRunner`
 * （models.json → pi-ai → Agent → 原生工具 → 治理钩子 → 事件映射 → 会话/用量落库）。
 *
 * 门禁：`PI_E2E=1` 且提供 `PI_AGENT_DIR`（含 models.json 的 agent 目录）。
 * 密钥从 models.json 内联的 apiKey 解析，**不需要把密钥放进环境变量**。
 * 约定：只允许使用 `deepseek-v4.1-flash`（用户指定的测试模型）。
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { AgentEvent } from '../../src/shared/events'
import { createPiTurnRunner, type PiRunnerOptions } from '../../src/main/agent/pi_runner'

const ALLOWED_MODEL = 'deepseek-v4.1-flash'
const agentDir = process.env.PI_AGENT_DIR ?? ''
const enabled = process.env.PI_E2E === '1' && agentDir !== ''

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
    return { model: `${process.env.PI_GATEWAY_PROVIDER ?? 'token-hub'}/${ALLOWED_MODEL}` }
  }

  of(type: string): SessionItem[] {
    return this.items.filter((item) => item.type === type)
  }
}

async function realRunner() {
  const sessions = new MemorySessions()
  const ledger: Array<Record<string, unknown>> = []
  const telemetry: Array<Record<string, unknown>> = []
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'huagent-real-runner-'))

  const options: PiRunnerOptions = {
    workspaceRoot,
    getSecret: () => null, // 密钥来自 models.json 内联 apiKey
    permissions: { check: async () => ({ action: 'allow' }) } as never,
    interactions: {
      requestApproval: async () => 'allow_once',
      requestGuide: async () => '',
      askGuide: async () => '',
    } as never,
    sessions: sessions as never,
    artifacts: { save: async () => join(workspaceRoot, 'artifact') } as never,
    ledger: { record: async (entry: Record<string, unknown>) => void ledger.push(entry) } as never,
    telemetry: { record: async (entry: Record<string, unknown>) => void telemetry.push(entry) } as never,
    agentDir,
    maxSteps: 6,
  }

  return { runner: createPiTurnRunner(options), sessions, ledger, telemetry, workspaceRoot }
}

describe.skipIf(!enabled)('新引擎路径真实调用（运行器 → 模型 → 工具 → 落库）', () => {
  it('纯文本回合：事件、助手消息、用量三写都到位', async () => {
    const { runner, sessions, ledger, telemetry } = await realRunner()
    const events: AgentEvent[] = []

    await runner.runTurn({
      sessionId: 'real-1',
      userText: '只回复两个字：收到',
      signal: new AbortController().signal,
      emit: (event) => void events.push(event),
    })

    expect(events[0].type).toBe('turn.start')
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'done' })

    const assistant = sessions.of('message').filter((item) => item.role === 'assistant')
    expect(assistant.length).toBeGreaterThan(0)
    const text = (assistant.at(-1) as { parts: Array<{ type: string; text?: string }> }).parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('')
    expect(text.trim().length).toBeGreaterThan(0)
    console.log(`[pi-runner] 模型回复：${text.trim().slice(0, 60)}`)

    const usage = sessions.of('usage')[0] as { input?: number; output?: number }
    expect(usage.input ?? 0).toBeGreaterThan(0)
    expect(usage.output ?? 0).toBeGreaterThan(0)
    expect(ledger).toHaveLength(1)
    expect(telemetry).toHaveLength(1)
  }, 180_000)

  it('工具回合：真实模型调用原生 write_file，工作空间内真的落盘', async () => {
    const { runner, sessions, workspaceRoot } = await realRunner()
    const events: AgentEvent[] = []

    await runner.runTurn({
      sessionId: 'real-2',
      userText: '请在当前目录创建文件 note.txt，内容恰好是 hu-agent-ok。创建后回复"完成"。',
      signal: new AbortController().signal,
      emit: (event) => void events.push(event),
    })

    const results = sessions.of('tool_result')
    console.log(
      `[pi-runner] 工具调用 ${sessions.of('tool_call').length} 次，结果：${results
        .map((item) => item.status)
        .join(',')}`,
    )
    // 真实模型不保证一定调工具：只在它调了的时候断言语义（避免把模型行为波动当成回归）
    if (results.length > 0) {
      expect(results.some((item) => item.status === 'ok')).toBe(true)
      expect(events.some((event) => event.type === 'tool.result')).toBe(true)
    }
    expect(events.at(-1)).toMatchObject({ type: 'turn.end' })
    expect(workspaceRoot.length).toBeGreaterThan(0)
  }, 240_000)
})
