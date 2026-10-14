/**
 * pi-durable 扩展/钩子 spike（R1 关键未知）：回合由 harness 跑时，我们的治理能否直接落位。
 *
 * 三条要证实：
 * 1. 工具经扩展注入 + `configure({ tools, modelTools })` 后，**真实模型能调用它**；
 * 2. `beforeTool` 钩子**支持异步**（我们的权限判定要 await 审批）；
 * 3. 钩子返回 `{ block }` 时工具体**不执行**（治理红线）。
 *
 * 门禁：`PI_E2E=1` + `PI_AGENT_DIR`（含 models.json 的 agent 目录，密钥内联在该文件）。
 * 只用 `deepseek-v4.1-flash`（用户指定）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, ToolTask, createRegistry, defineExtension, defineTool, hook, section } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Type } from 'typebox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ALLOWED_MODEL = 'deepseek-v4.1-flash'
const PROVIDER = process.env.PI_GATEWAY_PROVIDER ?? 'token-hub'
const agentDir = process.env.PI_AGENT_DIR ?? ''
const enabled = process.env.PI_E2E === '1' && agentDir !== ''

describe.skipIf(!enabled)('pi-durable 钩子 + 真实模型（治理落位验证）', () => {
  let dir: string
  let file: string
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-hooks-real-'))
    file = join(dir, 'session.sqlite')
  })

  afterEach(async () => {
    await storage?.close(BACKGROUND_CONTEXT).catch(() => undefined)
    storage = null
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined)
  })

  it('异步 beforeTool 阻断：真实模型发起调用 → 钩子拒绝 → 工具体未执行', async () => {
    const executed: string[] = []
    const decisions: string[] = []

    // 模拟我们的权限引擎（异步等待审批），此处固定拒绝
    const gate = {
      check: async (name: string): Promise<{ allow: boolean; reason?: string }> => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        decisions.push(name)
        return { allow: false, reason: `策略拒绝：${name}` }
      },
    }

    const Guard = defineExtension({
      name: 'huagent.guard',
      sections: [section('workspace', () => '工作空间：/ws（只读）', { tag: false })],
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call: { name: string }) => {
            const decision = await gate.check(call.name)
            return decision.allow ? undefined : { block: decision.reason }
          },
        }),
      ],
    })

    const echo = defineTool({
      name: 'echo',
      description: '回显给定文本',
      parameters: Type.Object({ text: Type.String({ description: '要回显的文本' }) }),
      execute: async (_id: string, params: { text?: string }) => {
        executed.push(String(params?.text ?? ''))
        return { content: [{ type: 'text', text: `echo:${params?.text}` }] }
      },
    })
    const Tools = defineExtension({ name: 'huagent.tools', tools: [echo] })

    const registry = createRegistry()
    registry.install(Tools)
    registry.install(Guard)

    // 真实 provider：用我们的配置层读取 models.json（密钥内联在该文件里）
    const { listProviders, readModelsFile, buildPiProviders } = await import('../../src/main/model/pi_config')
    const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
    const models = createModels()
    const configPath = join(agentDir, 'models.json')
    const configFile = await readModelsFile(configPath)
    const providers = await listProviders(configPath, () => false)
    for (const built of buildPiProviders(providers, configFile, () => openAICompletionsApi(), () => null)) {
      models.setProvider(built.provider as never)
    }

    storage = await openNodeSqliteStorage(file)
    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT)
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER, modelId: ALLOWED_MODEL } },
    })

    await root.configure({ extensions: [Tools, Guard], tools: [echo], modelTools: [echo] }, BACKGROUND_CONTEXT)

    const submission = await root.submit(
      {
        type: 'input',
        content: '请调用 echo 工具，参数 text 为 "hi"。调用后回复"已完成"。',
        requestId: 'hooks-real-1',
      },
      BACKGROUND_CONTEXT,
    )
    const settled = (await submission.wait(BACKGROUND_CONTEXT)) as unknown as Record<string, unknown>
    console.log('[hooks-real] settled =', JSON.stringify(settled).slice(0, 200))
    console.log('[hooks-real] decisions =', decisions.join(','), '| executed =', executed.join(','))

    // 治理红线：钩子被调用（异步生效），且工具体未执行
    expect(decisions.length).toBeGreaterThan(0)
    expect(executed).toEqual([])
  }, 240_000)
})
