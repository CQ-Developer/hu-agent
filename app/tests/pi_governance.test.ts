/**
 * 默认工具集测试（R1 切换后）：`createDefaultTools` 按工作空间装配 pi 原生 `AgentTool`。
 *
 * 治理（权限/审批/拒绝/截断）已随回合回环移到 `agent/durable_loop.ts` 的扩展钩子，
 * 由 `tests/durable_loop.test.ts`（契约）与 `tests/integration/pi_durable_hooks_real.test.ts`
 * （真实模型下"钩子阻断 → 工具体不执行"）覆盖。
 */

import { describe, expect, it } from 'vitest'

import { createDefaultTools } from '../src/main/agent/pi_governance'

describe('默认工具集', () => {
  const tools = createDefaultTools({
    workspaceRoot: '/ws',
    interactions: {} as never,
    sessionId: 's1',
    turnId: 't1',
  })

  it('六个内置工具，名称与分类固定（分类供权限策略使用）', () => {
    expect(tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'bash',
      'powershell',
      'ask_guide',
    ])
    expect(Object.fromEntries(tools.map((tool) => [tool.name, tool.category]))).toEqual({
      read_file: 'read',
      write_file: 'write',
      edit_file: 'write',
      bash: 'exec',
      powershell: 'exec',
      ask_guide: 'interact',
    })
  })

  it('工具是 pi 原生形态（typebox 参数 + execute），可直接交给 pi', () => {
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function')
      expect(tool.parameters).toBeDefined()
      expect(tool.description.length).toBeGreaterThan(0)
    }
  })
})
