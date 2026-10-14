/**
 * 治理钩子测试（R2）：用 faux provider 跑**真实 Agent 循环**，断言三条企业红线：
 *
 * 1. 放行 → 工具体执行，结果与状态如实回传；
 * 2. 拒绝 → 工具体**一次都不执行**，且 UI 能区分"被拒绝"与"执行报错"（status = denied）；
 * 3. 审批是**异步等待**用户的：引擎在等审批时不放行、批准后正常执行、拒绝后不执行。
 *
 * 工具全部是 pi 原生 `AgentTool`（治理只通过钩子介入，不做包装）。
 */

import { Agent } from '@earendil-works/pi-agent-core'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Type } from 'typebox'
import { describe, expect, it } from 'vitest'

import { mapPiEvent } from '../src/main/agent/pi-events'
import {
  createAfterToolCall,
  createBeforeToolCall,
  createGovernanceState,
  type GovernanceDeps,
} from '../src/main/agent/pi-governance'
import type { PermissionCheck, PermissionDecision } from '../src/main/permissions/types'
import type { NativeTool } from '../src/main/tools/native/tool'

type Decision = PermissionDecision | ((check: PermissionCheck) => Promise<PermissionDecision>)

/** 原生工具：pi 的 AgentTool + category（权限策略需要） */
function makeTool(executed: string[]): NativeTool {
  return {
    name: 'read_file',
    label: '读取文件',
    category: 'read',
    description: '读取文件',
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_toolCallId, params) => {
      executed.push(String((params as { path?: string }).path ?? ''))
      return { content: [{ type: 'text' as const, text: '文件内容' }], details: { status: 'ok' } }
    },
  }
}

function makeDeps(executed: string[], decide: Decision): { deps: GovernanceDeps; calls: PermissionCheck[] } {
  const calls: PermissionCheck[] = []
  const deps: GovernanceDeps = {
    workspaceRoot: '/ws',
    permissions: {
      check: async (check: PermissionCheck) => {
        calls.push(check)
        return typeof decide === 'function' ? await decide(check) : decide
      },
    } as unknown as GovernanceDeps['permissions'],
    tools: [makeTool(executed)],
  }
  return { deps, calls }
}

interface ToolEnd {
  id: string
  status?: string
  text: string
}

function runAgent(deps: GovernanceDeps, responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider({ models: [{ id: 'faux-1', name: 'Faux' }] })
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses(responses)

  const state = createGovernanceState()
  const scope = { sessionId: 's1', turnId: 't1' }
  const events: string[] = []
  const toolEnds: ToolEnd[] = []

  const agent = new Agent({
    initialState: {
      systemPrompt: '测试',
      model: models.getModel('faux', 'faux-1')!,
      tools: deps.tools,
    },
    streamFn: models.streamSimple.bind(models),
    beforeToolCall: createBeforeToolCall(deps, scope, state),
    afterToolCall: createAfterToolCall(
      { artifacts: { save: async () => '/tmp/artifact' } as never, outputLimit: 32_000 },
      state,
    ),
  })

  agent.subscribe((event) => {
    events.push(event.type)
    // 断言 UI 真正消费的东西：映射后的事件流
    const mapped = mapPiEvent(event as never, {
      sessionId: 's1',
      turnId: 't1',
      provider: 'faux',
      model: 'faux-1',
      denials: state.blocked,
    })
    for (const item of mapped) {
      if (item.type === 'tool.result') {
        toolEnds.push({ id: item.result.id, status: item.result.status, text: item.result.output })
      }
    }
  })

  return { agent, events, toolEnds, state }
}

describe('治理钩子（权限 / 拒绝 / 审批）', () => {
  it('放行：工具体执行，权限检查带上正确的工具与参数', async () => {
    const executed: string[] = []
    const { deps, calls } = makeDeps(executed, { action: 'allow' })

    const { agent, events, toolEnds } = runAgent(deps, [
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
    expect(toolEnds[0]).toMatchObject({ status: 'ok', text: '文件内容' })
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
    expect(toolEnds).toHaveLength(1)
    expect(toolEnds[0].status).toBe('denied')
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
    const { agent, toolEnds } = runAgent(deps, [
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'a.txt' })]),
      fauxAssistantMessage('完成'),
    ])

    deps.tools = [] // 调用发生时工具已不可用（例如 MCP 断开）
    await agent.prompt('读文件')

    expect(executed).toEqual([])
    expect(toolEnds[0].status).toBe('denied')
  })
})
