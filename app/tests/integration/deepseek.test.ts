/** 真实模型集成测试（需要网络与密钥，默认跳过）。
 *
 * 运行方式：
 *   DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-flash \
 *     npx vitest run tests/integration/deepseek.test.ts --reporter=verbose
 *
 * 注意：密钥只从环境变量读取，不落盘、不打印。
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runTurn } from '../../src/main/agent/loop'
import { ModelGateway } from '../../src/main/model/gateway'
import type { ModelSettings } from '../../src/main/model/types'
import { ArtifactStore } from '../../src/main/session/artifacts'
import { SessionStore } from '../../src/main/session/store'
import { createDefaultToolRegistry } from '../../src/main/tools/registry'
import { UsageLedger } from '../../src/main/usage/ledger'

const apiKey = process.env.DEEPSEEK_API_KEY
const modelName = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'

const settings: ModelSettings = {
  providers: [
    {
      id: 'deepseek',
      type: 'openai-compatible',
      baseUrl,
      apiKeyRef: 'deepseek',
      models: [
        {
          name: modelName,
          roles: ['primary', 'fast'],
          capabilities: { tools: true, contextWindow: 65536, maxOutput: 4096 },
        },
      ],
    },
  ],
  defaults: { primary: `deepseek/${modelName}`, fast: `deepseek/${modelName}` },
}

const gateway = new ModelGateway({
  getSettings: () => settings,
  getSecret: (ref) => (ref === 'deepseek' ? (apiKey ?? null) : null),
})

describe.skipIf(!apiKey)('DeepSeek 真实模型集成', () => {
  it(
    '基础对话：流式返回文本与 usage',
    async () => {
      const events = []
      for await (const event of gateway.chat(
        'primary',
        [{ role: 'user', content: '用一句话回答：1+1 等于几？' }],
        [],
        AbortSignal.timeout(60_000),
      )) {
        events.push(event)
      }

      const text = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => (event.type === 'text_delta' ? event.text : ''))
        .join('')
      expect(text.length).toBeGreaterThan(0)
      expect(events.at(-1)?.type).toBe('done')

      const usage = events.find((event) => event.type === 'usage')
      expect(usage && usage.type === 'usage' ? usage.usage.inputTokens : 0).toBeGreaterThan(0)
    },
    90_000,
  )

  it(
    'Agent Loop：真实工具调用（write_file）写入工作空间',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'huagent-deepseek-'))
      try {
        const sessions = new SessionStore(join(root, '.hu', 'sessions'))
        const meta = await sessions.create('DeepSeek 冒烟')
        const ledger = new UsageLedger(join(root, '.hu', 'usage.jsonl'))
        const events: string[] = []

        await runTurn(
          {
            gateway,
            tools: createDefaultToolRegistry(),
            sessions,
            artifacts: new ArtifactStore(join(root, '.hu', 'sessions', 'artifacts')),
            ledger,
            emit: (event) => events.push(event.type),
            workspaceRoot: root,
          },
          {
            sessionId: meta.id,
            userText: '请在工作空间根目录创建文件 agent-smoke.txt，内容为一行 hello from deepseek。完成后回复“完成”。',
            signal: AbortSignal.timeout(120_000),
          },
        )

        expect(events).toContain('tool.call')
        expect(events).toContain('tool.result')

        const { lines } = await sessions.readLines(meta.id)
        const toolCallLine = lines.find((line) => line.type === 'tool_call')
        const toolResultLine = lines.find((line) => line.type === 'tool_result')
        expect(toolCallLine && toolCallLine.type === 'tool_call' ? toolCallLine.name : undefined, `tool_call=${JSON.stringify(toolCallLine)}`).toBe(
          'write_file',
        )
        expect(
          toolResultLine && toolResultLine.type === 'tool_result' ? toolResultLine.status : undefined,
          `tool_result=${JSON.stringify(toolResultLine)}`,
        ).toBe('ok')

        const content = await readFile(join(root, 'agent-smoke.txt'), 'utf8')
        expect(content).toContain('hello from deepseek')

        const stats = await ledger.stats()
        expect(stats.calls).toBeGreaterThan(0)
        expect(stats.inputTokens).toBeGreaterThan(0)
        expect(events.at(-1)).toBe('turn.end')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
