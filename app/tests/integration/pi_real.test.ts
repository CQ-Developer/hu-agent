/**
 * P1/P2 真实调用验证：走企业 OpenAI 兼容网关，验证 pi-ai 与 pi-agent-core 在真实模型上可用。
 *
 * 门禁：`PI_E2E=1` 且提供 `PI_GATEWAY_BASE_URL` / `PI_GATEWAY_API_KEY`（缺失即跳过）。
 * 密钥只从环境变量读取，绝不写入仓库；运行方式见 CONTRIBUTING「真实调用验证」。
 *
 * 约定：本文件**只允许使用 `deepseek-v4.1-flash`**（用户指定的测试模型，避免误用其他模型产生费用）。
 */

import { Agent, type AgentTool } from '@earendil-works/pi-agent-core'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'

const ALLOWED_MODEL = 'deepseek-v4.1-flash'
const apiKey = process.env.PI_GATEWAY_API_KEY ?? ''
const baseUrl = process.env.PI_GATEWAY_BASE_URL ?? ''
const enabled = process.env.PI_E2E === '1' && apiKey !== '' && baseUrl !== ''

function gatewayModels() {
  const provider = createProvider({
    id: 'huagent-gateway',
    name: 'hu-agent 网关（OpenAI 兼容）',
    baseUrl,
    // ProviderAuth 的形状是 { apiKey: ApiKeyAuth }（见 pi 官方 deepseek provider）；
    // 直接传 ApiKeyAuth 本体不会被识别，会报 "Provider is not configured"。
    auth: {
      apiKey: {
        name: '网关 API Key',
        login: async () => ({ type: 'api_key' as const, key: apiKey }),
        resolve: async () => ({ auth: { apiKey }, source: 'environment' as const }),
      },
    } as unknown as Parameters<typeof createProvider>[0]['auth'],
    // 注意：createProvider 的 models 必须是**完整 Model 对象**——除 id/name/能力字段外，
    // 还要带 api / provider / baseUrl，否则 streamSimple 会以 "Unknown provider: undefined" 失败。
    // 我们从用户配置读自定义 provider 时（P1 实现）必须补齐这三个字段。
    models: [
      {
        id: ALLOWED_MODEL,
        name: 'DeepSeek V4.1 Flash',
        api: 'openai-completions' as const,
        provider: 'huagent-gateway',
        baseUrl,
        reasoning: true,
        input: ['text' as const],
        contextWindow: 128_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } as unknown as Parameters<typeof createProvider>[0]['models'][number],
    ],
    api: openAICompletionsApi(),
  })
  const models = createModels()
  models.setProvider(provider)
  const model = models.getModel('huagent-gateway', ALLOWED_MODEL)
  if (!model) throw new Error(`网关未提供模型 ${ALLOWED_MODEL}`)
  // 密钥按请求注入：与企业版「密钥存在服务端 / safeStorage，不进 pi 凭证库」的设计一致
  const streamFn = (m: typeof model, context: never, options: never) =>
    models.streamSimple(m, context, { ...(options as object), apiKey })
  return { models, model, streamFn }
}

describe.skipIf(!enabled)('pi-ai 真实调用（OpenAI 兼容网关）', () => {
  it('流式返回文本', async () => {
    const { models, model, streamFn } = gatewayModels()
    const stream = streamFn(
      model,
      {
        messages: [
          { role: 'system', content: '你是简洁的助手，回答不超过 10 个字。', timestamp: Date.now() },
          { role: 'user', content: '只回复两个字：收到', timestamp: Date.now() },
        ],
      },
      {},
    )

    let text = ''
    const sequence: string[] = []
    for await (const event of stream) {
      sequence.push(event.type)
      if (event.type === 'text_delta') text += event.delta
      if (event.type === 'error') {
        // 错误详情在 event.error.errorMessage（event 本身是 assistant 消息包装）
        const detail = event as {
          error?: { errorMessage?: string; stopReason?: string }
          errorMessage?: string
          reason?: string
        }
        throw new Error(
          `provider 返回错误：${detail.error?.errorMessage ?? detail.errorMessage ?? detail.reason ?? JSON.stringify(event).slice(0, 400)}`,
        )
      }
    }

    // 不绑定具体终止事件名（代理协议与原生事件流命名不同），只断言内容与序列形状
    expect(sequence).toContain('text_delta')
    expect(text.trim().length).toBeGreaterThan(0)
    console.log(`[pi-real] 事件序列：${sequence.join(' → ')}`)
    console.log(`[pi-real] ${ALLOWED_MODEL} 回复：${text.trim().slice(0, 60)}`)
  }, 120_000)

  it('Agent 完整回合：真实模型 + 工具执行 + 用量回传', async () => {
    const { models, model, streamFn } = gatewayModels()
    const executed: string[] = []
    const events: string[] = []

    const echo: AgentTool = {
      name: 'echo',
      label: 'Echo',
      description: '回显文本，必须用于确认收到内容',
      parameters: Type.Object({ text: Type.String({ description: '要回显的文本' }) }),
      execute: async (_toolCallId, params) => {
        const { text } = params as { text: string }
        executed.push(text)
        return { content: [{ type: 'text', text: `echo:${text}` }], details: undefined }
      },
    } as AgentTool

    const agent = new Agent({
      initialState: {
        systemPrompt: '用户给出文本时，必须调用 echo 工具回显，然后用一句话总结。',
        model,
        tools: [echo],
      },
      streamFn: streamFn as never,
    })
    agent.subscribe((event) => {
      events.push(event.type)
    })

    await agent.prompt('请回显：真实调用验证')

    expect(events[0]).toBe('agent_start')
    expect(events.at(-1)).toBe('agent_end')

    const assistant = agent.state.messages.filter((message) => message.role === 'assistant')
    expect(assistant.length).toBeGreaterThan(0)
    // 用量必须回传：企业侧的用量与成本统计依赖它
    const last = assistant.at(-1) as {
      usage?: { totalTokens?: number; input?: number; output?: number }
      stopReason?: string
      errorMessage?: string
    }
    // 真实调用必须成功：error/aborted 都算失败（否则断言会被"错误消息也带 usage"蒙混过关）
    expect(last.stopReason).not.toBe('error')
    expect(last.errorMessage).toBeUndefined()
    const usage = last.usage
    expect(usage).toBeDefined()
    console.log(
      `[pi-real] 回合数=${assistant.length} 工具调用=${executed.length} 用量=${JSON.stringify(usage)}`,
    )
  }, 180_000)
})
