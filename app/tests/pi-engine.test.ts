/**
 * P1 冒烟：pi-ai + pi-agent-core 在本仓库真实可跑（零网络，用 pi 自带的 faux provider）。
 *
 * 这三条断言是 ADR-0006「全量采用 pi 组件」能成立的前提：
 * 1) 模型目录与 provider 注册契约可用（真实 provider 走同一套 Models/streamFn 契约）；
 * 2) Agent 能跑完整回合：流式文本 + 工具调用 + 工具结果回灌给模型；
 * 3) 我们的治理缝隙 `beforeToolCall` 能真正阻断工具执行（权限/审批的挂载点）。
 *
 * 这里刻意不联网：真实 provider 的调用由现有 e2e（DEEPSEEK_* 门禁）覆盖，
 * 本文件只锁定「契约与钩子」这一层，保证 CI 可稳定运行。
 */

import { Agent, type AgentTool, streamProxy } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'

type Events = string[]

function createEchoTool(executed: string[]): AgentTool {
  return {
    name: 'echo',
    label: 'Echo',
    description: '回显给定文本',
    parameters: Type.Object({ text: Type.String({ description: '要回显的文本' }) }),
    execute: async (_toolCallId, params) => {
      const { text } = params as { text: string }
      executed.push(text)
      return { content: [{ type: 'text', text: `echo:${text}` }], details: undefined }
    },
  } as AgentTool
}

function createFauxModels(): { models: ReturnType<typeof createModels>; faux: ReturnType<typeof fauxProvider> } {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux 1' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  return { models, faux }
}

describe('pi 引擎接入（P1 冒烟）', () => {
  it('模型目录与 provider 注册契约可用', () => {
    const { models } = createFauxModels()
    const model = models.getModel('faux', 'faux-1')
    expect(model).toMatchObject({ id: 'faux-1', provider: 'faux' })
    expect(models.getModel('faux', '不存在')).toBeUndefined()
  })

  it('真实 provider 模块可加载且覆盖我们需要的三种 API 类型', async () => {
    // 只验证目录与类型映射，不发起任何请求（真实调用由 e2e 门禁覆盖）
    const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic')
    const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai')
    const { deepseekProvider } = await import('@earendil-works/pi-ai/providers/deepseek')

    const models = createModels()
    models.setProvider(anthropicProvider())
    models.setProvider(openaiProvider())
    models.setProvider(deepseekProvider())

    const apis = new Set(
      [anthropicProvider(), openaiProvider(), deepseekProvider()].flatMap((provider) =>
        provider.getModels().map((model) => model.api),
      ),
    )
    expect([...apis].some((api) => api === 'anthropic-messages')).toBe(true)
    expect([...apis].some((api) => api.startsWith('openai-'))).toBe(true)

    // 目录里的模型 id 随上游变化，取第一个来验证注册/查找链路，不写死具体 id
    const deepseekModels = deepseekProvider().getModels()
    expect(deepseekModels.length).toBeGreaterThan(0)
    const deepseek = models.getModel('deepseek', deepseekModels[0].id)
    expect(deepseek?.provider).toBe('deepseek')
  })

  it('Agent 跑完一轮：流式文本 + 工具调用 + 工具结果回灌', async () => {
    const { models, faux } = createFauxModels()
    const executed: string[] = []
    const events: Events = []

    faux.setResponses([
      fauxAssistantMessage([fauxText('先回显'), fauxToolCall('echo', { text: 'hi' })]),
      fauxAssistantMessage('完成'),
    ])

    const agent = new Agent({
      initialState: {
        systemPrompt: '你是测试助手',
        model: models.getModel('faux', 'faux-1')!,
        tools: [createEchoTool(executed)],
      },
      streamFn: models.streamSimple.bind(models),
    })
    agent.subscribe((event) => {
      events.push(event.type)
    })

    await agent.prompt('你好')

    expect(executed).toEqual(['hi'])
    expect(events[0]).toBe('agent_start')
    expect(events.at(-1)).toBe('agent_end')
    expect(events).toContain('tool_execution_start')
    expect(events).toContain('tool_execution_end')
    // 工具结果必须回到模型：两轮 provider 调用
    expect(faux.state.callCount).toBe(2)
    const toolResults = agent.state.messages.filter((message) => message.role === 'toolResult')
    expect(toolResults).toHaveLength(1)
  })

  it('beforeToolCall 能阻断工具执行（权限/审批的挂载点）', async () => {
    const { models, faux } = createFauxModels()
    const executed: string[] = []
    const events: Events = []
    const blocked: string[] = []

    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('echo', { text: '不该执行' })]),
      fauxAssistantMessage('已跳过'),
    ])

    const agent = new Agent({
      initialState: {
        systemPrompt: '你是测试助手',
        model: models.getModel('faux', 'faux-1')!,
        tools: [createEchoTool(executed)],
      },
      streamFn: models.streamSimple.bind(models),
      beforeToolCall: async ({ toolCall }) => {
        blocked.push(toolCall.name)
        return { block: true, reason: '审批未通过' }
      },
    })
    agent.subscribe((event) => {
      events.push(event.type)
    })

    await agent.prompt('执行 echo')

    expect(blocked).toEqual(['echo'])
    expect(executed).toEqual([]) // 工具体没有被执行
    expect(events.at(-1)).toBe('agent_end')
    // 被阻断的结果仍以 toolResult 形式回到模型（模型据此继续，而不是卡死）
    expect(agent.state.messages.some((message) => message.role === 'toolResult')).toBe(true)
  })

  it('企业网关模式的 streamProxy 入口可用', () => {
    expect(typeof streamProxy).toBe('function')
  })
})
