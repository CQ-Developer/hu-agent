/**
 * 默认工具集（pi 原生 `AgentTool`，typebox 参数）。
 *
 * 治理**不在本模块**：权限判定、审批、审计与超长输出截断都发生在回合回环的扩展钩子里
 * （`agent/durable_loop.ts` 的 `beforeTool`/`afterTool`，pi-durable 原生缝隙），
 * 因此这里只负责按工作空间装配工具，不做任何包装或翻译。
 */

import type { InteractionBroker } from '../permissions/broker'
import { createAskGuideTool } from '../tools/native/ask_guide'
import { createEditFileTool } from '../tools/native/edit_file'
import { createReadFileTool } from '../tools/native/read_file'
import { createBashTool, createPowerShellTool } from '../tools/native/shell'
import type { NativeTool } from '../tools/native/tool'
import { createWriteFileTool } from '../tools/native/write_file'

/** 默认工具集：全部 pi 原生；`category` 供权限策略使用 */
export function createDefaultTools(options: {
  workspaceRoot: string
  interactions: InteractionBroker
  sessionId: string
  turnId: string
}): NativeTool[] {
  const { workspaceRoot } = options
  return [
    createReadFileTool({ workspaceRoot }),
    createWriteFileTool({ workspaceRoot }),
    createEditFileTool({ workspaceRoot }),
    createBashTool({ workspaceRoot }),
    createPowerShellTool({ workspaceRoot }),
    createAskGuideTool({
      workspaceRoot,
      interactions: options.interactions,
      sessionId: options.sessionId,
      turnId: options.turnId,
    }),
  ]
}
