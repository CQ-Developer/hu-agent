/**
 * 治理适配测试（P1.2-b）：用 faux provider 跑**真实 Agent 循环**，断言三条企业红线：
 *
 * 1. 放行 → 工具体执行，结果与状态如实回传；
 * 2. 拒绝 → 工具体**一次都不执行**，且 UI 能区分"被拒绝"与"执行报错"（details.status = denied）；
 * 3. 审批是**异步等待**用户的：引擎在等审批时不放行、批准后正常执行、拒绝后不执行。
 *
 * 这三条就是"换引擎不降低治理强度"的证据，也是 ADR-0006 决策 3 的验收方式。
 */

import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { describe, expect, it } from 'vitest'

import { mapPiEvent } from '../src/main/agent/pi-events'
import {
  createAfterToolCall,
  createAgentTools,
  createBeforeToolCall,
  createGovernanceState,
  type GovernanceDeps,
} from '../src/main/agent/pi-governance'
import type { PermissionDecision, PermissionCheck } from '../src/main/permissions/types'
import type { AnyTool, ToolContext, ToolResult } from '../src/main/tools/types'

type Decision = PermissionDecision | ((check: PermissionCheck) => Promise<PermissionDecision>)

function makeTool(executed: string[], result: Partial<ToolResult> = {}): AnyTool {
  return {
    name: 'read_file',
    description: '读取文件',
    category: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (input: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      executed.push(String((input as { path?: string }).path ?? ''))
      return { status: 'ok', output: '文件内容', ...result }
    },
  }
}

function makeDeps(
  executed: string[],
  decide: Decision,
  toolResult: Partial<ToolResult> = {},
): { deps: GovernanceDeps; calls: PermissionCheck[] } {
  const calls: PermissionCheck[] = []
  const deps: GovernanceDeps = {
    workspaceRoot: '/ws',
    permissions: {
      check: async (check: PermissionCheck) => {
        calls.push(check)
        return typeof decide === 'function' ? await decide(check) : decide
      },
    } as unknown as GovernanceDeps['permissions'],
    artifacts: { save: async () => '/tmp/artifact' } as unknown as GovernanceDeps['artifacts'],
    interactions: {
      requestApproval: async () => 'deny',
      requestGuide: async () => '',
    } as unknown as GovernanceDeps['interactions'],
    tools: [makeTool(executed, toolResult)],
  }
  return { deps, calls }
}

function runAgent(deps: GovernanceDeps, responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)

  const state = createGovernanceState()
  const scope = { sessionId: 's1', turnId: 't1', signal: new AbortController().signal }
  const events: string[] = []
  const toolEnds: Array<{ id: string; status?: string; reason?: string; text: string; isError: boolean }> = []

  const agent = new Agent({
    initialState: {
      systemPrompt: '测试',
      model: models.getModel('faux', 'faux-1')!,
      tools: createAgentTools(deps, scope),
    },
    streamFn: models.streamSimple.bind(models),
    beforeToolCall: createBeforeToolCall(deps, scope, state),
    afterToolCall: createAfterToolCall(state),
  })
  agent.subscribe((event) => {
    events.push(event.type)
    // 断言 UI 真正消费的东西：映射后的事件
    const mapped = mapPiEvent(event as never, {
      sessionId: 's1',
      turnId: 't1',
      provider: 'faux',
      model: 'faux-1',
      denials: state.blocked,
    })
    for (const item of mapped) {
      if (item.type === 'tool.result') {
        toolEnds.push({
          id: item.result.id,
          status: item.result.status,
          reason: item.result.output,
          text: item.result.output,
          isError: event.type === 'tool_execution_end' ? event.isError : false,
        })
      }
    }
  })
  return { agent, events, toolEnds, state }
}

describe('治理适配（权限 / 拒绝 / 审批）', () => {
  it('放行：工具体执行，权限检查带上正确的工具与参数', async () => {
    const executed: string[] = []
    const { deps, calls } = makeDeps(executed, { action: 'allow' })

    const { agent, events } = runAgent(deps, [
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'a.txt' })]),
      fauxAssistantMessage('完成'),
    ])
    await agent.prompt('读文件')

    expect(executed).toEqual(['a.txt'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      sessionId: 's1',
      turnId: 't1',
      toolName: 'read_file',
      category: 'read',
      input: { path: 'a.txt' },
    })
    expect(events.at(-1)).toBe('agent_end')

    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult') as {
      details?: { status?: string }
      content?: Array<{ text?: string }>
    }
    expect(toolResult.details?.status).toBe('ok')
    expect(toolResult.content?.[0]?.text).toBe('文件内容')
  })

  it('拒绝：工具体一次都不执行，且结果标记为 denied（不是技术错误）', async () => {
    const executed: string[] = []
    const { deps } = makeDeps(executed, { action: 'deny', reason: '当前权限策略拒绝该操作' })

    const { agent, toolEnds } = runAgent(deps, [
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'secret.txt' })]),
      fauxAssistantMessage('已跳过'),
    ])
    await agent.prompt('读敏感文件')

    expect(executed).toEqual([]) // 红线：拒绝时工具体不得执行
    // UI 消费的是事件流（afterToolCall 的 details 覆盖体现在 tool_execution_end）
    expect(toolEnds).toHaveLength(1)
    expect(toolEnds[0]).toMatchObject({ status: 'denied', reason: '当前权限策略拒绝该操作' })
    expect(toolEnds[0].text).toBe('当前权限策略拒绝该操作')
    // 模型侧仍应把它当成错误处理（transcript 的 toolResult 带 isError）
    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult') as { isError?: boolean }
    expect(toolResult.isError).toBe(true)
  })

  it('审批异步等待：待审批期间不放行，批准后执行；拒绝则不执行', async () => {
    for (const [choice, shouldRun] of [
      ['allow_once', true],
      ['deny', false],
    ] as const) {
      const executed: string[] = []
      let release: (decision: PermissionDecision) => void = () => {}
      const gate = new Promise<PermissionDecision>((resolve) => {
        release = resolve
      })

      const { deps } = makeDeps(executed, async () => await gate)
      const { agent, state } = runAgent(deps, [
        fauxAssistantMessage([fauxToolCall('read_file', { path: 'a.txt' })]),
        fauxAssistantMessage('完成'),
      ])

      const running = agent.prompt('读文件')
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(executed).toEqual([]) // 审批未决 → 尚未执行
      expect(state.blocked.size).toBe(0)

      release(choice === 'allow_once' ? { action: 'allow' } : { action: 'deny', reason: '用户拒绝了该操作' })
      await running

      expect(executed).toEqual(shouldRun ? ['a.txt'] : [])
      expect(state.blocked.size).toBe(shouldRun ? 0 : 1)
    }
  })

  it('未知工具按拒绝处理（不落到默认放行）', async () => {
    const executed: string[] = []
    const { deps } = makeDeps(executed, { action: 'allow' })
    // 模型请求一个未注册的工具名
    const { agent } = runAgent(deps, [
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'a.txt' })]),
      fauxAssistantMessage('完成'),
    ])
    deps.tools = []
    await agent.prompt('读文件')

    expect(executed).toEqual([])
    expect(agent.state.messages.some((message) => message.role === 'toolResult')).toBe(true)
  })
})
