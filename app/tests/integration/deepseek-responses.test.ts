/** OpenAI Responses 协议真实模型集成测试（使用 DeepSeek 的 /responses 端点）。
 *
 * 运行方式：
 *   DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-flash \
 *     npx vitest run tests/integration/deepseek-responses.test.ts
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runTurn } from '../../src/main/agent/loop'
import { ModelGateway } from '../../src/main/model/gateway'
import type { ModelSettings } from '../../src/main/model/types'
import { ArtifactStore } from '../../src/main/session/artifacts'
import type { InteractionBroker } from '../../src/main/permissions/broker'
import type { PermissionEngine } from '../../src/main/permissions/engine'
import { SessionStore } from '../../src/main/session/store'
import { createDefaultToolRegistry } from '../../src/main/tools/registry'
import { UsageLedger } from '../../src/main/usage/ledger'

const apiKey = process.env.DEEPSEEK_API_KEY
const modelName = process.env.DEEPSEEK_MODEL ?? 'deepseek-flash'
const baseUrl = process.env.DEEPSEEK_RESPONSES_BASE_URL ?? 'https://api.deepseek.com'

const settings: ModelSettings = {
  providers: [
    {
      id: 'deepseek-responses',
      apiType: 'openai-responses',
      baseUrl,
      apiKeyRef: 'deepseek',
      models: [
        {
          name: modelName,
          roles: ['primary', 'fast'],
          capabilities: { tools: true, reasoningEffort: true, contextWindow: 65536, maxOutput: 4096 },
        },
      ],
    },
  ],
  defaults: { primary: `deepseek-responses/${modelName}`, fast: `deepseek-responses/${modelName}` },
}

const ALLOW_ALL = { check: async () => ({ action: 'allow' as const }) } as unknown as PermissionEngine
const NO_INTERACTIONS = {} as unknown as InteractionBroker

const gateway = new ModelGateway({
  getSettings: () => settings,
  getSecret: (ref) => (ref === 'deepseek' ? (apiKey ?? null) : null),
})

describe.skipIf(!apiKey)('DeepSeek Responses 协议集成', () => {
  it(
    '基础对话：Responses 流式与 usage',
    async () => {
      const events = []
      for await (const event of gateway.chat(
        { target: `deepseek-responses/${modelName}` },
        [{ role: 'user', content: 'Reply with exactly: pong' }],
        [],
        AbortSignal.timeout(60_000),
      )) {
        events.push(event)
      }

      const text = events
        .filter((event) => event.type === 'text_delta')
        .map((event) => (event.type === 'text_delta' ? event.text : ''))
        .join('')
      const reasoning = events
        .filter((event) => event.type === 'reasoning_delta')
        .map((event) => (event.type === 'reasoning_delta' ? event.text : ''))
        .join('')
      expect(text.length + reasoning.length).toBeGreaterThan(0)
      expect(events.at(-1)?.type).toBe('done')

      const usage = events.find((event) => event.type === 'usage')
      expect(usage && usage.type === 'usage' ? usage.usage.inputTokens : 0).toBeGreaterThan(0)
    },
    90_000,
  )

  it(
    '思考强度：Responses 的 reasoning 配置可用',
    async () => {
      const events = []
      for await (const event of gateway.chat(
        { target: `deepseek-responses/${modelName}`, reasoningEffort: 'medium' },
        [{ role: 'user', content: 'What is 17 * 23? Think step by step, then answer.' }],
        [],
        AbortSignal.timeout(90_000),
      )) {
        events.push(event)
      }

      expect(events.some((event) => event.type === 'text_delta' || event.type === 'reasoning_delta')).toBe(true)
      expect(events.at(-1)?.type).toBe('done')
    },
    120_000,
  )

  it(
    'Agent Loop：Responses 协议下真实工具调用（write_file）',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'huagent-ds-responses-'))
      try {
        const sessions = new SessionStore(join(root, '.hu', 'sessions'))
        const meta = await sessions.create('Responses 协议冒烟')
        const ledger = new UsageLedger(join(root, '.hu', 'usage.jsonl'))
        const events: string[] = []

        await runTurn(
          {
            gateway,
            tools: createDefaultToolRegistry(),
            sessions,
            artifacts: new ArtifactStore(join(root, '.hu', 'sessions', 'artifacts')),
            permissions: ALLOW_ALL,
            interactions: NO_INTERACTIONS,
            ledger,
            emit: (event) => events.push(event.type),
            workspaceRoot: root,
          },
          {
            sessionId: meta.id,
            userText:
              'Create a file named responses-smoke.txt in the workspace root containing exactly one line: hello from responses. Then reply "done".',
            signal: AbortSignal.timeout(120_000),
          },
        )

        expect(events).toContain('tool.call')
        expect(events).toContain('tool.result')

        const { lines } = await sessions.readLines(meta.id)
        const toolResultLine = lines.find((line) => line.type === 'tool_result')
        expect(
          toolResultLine && toolResultLine.type === 'tool_result' ? toolResultLine.status : undefined,
          `tool_result=${JSON.stringify(toolResultLine)}`,
        ).toBe('ok')

        const content = await readFile(join(root, 'responses-smoke.txt'), 'utf8')
        expect(content).toContain('hello from responses')
        expect(events.at(-1)).toBe('turn.end')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
