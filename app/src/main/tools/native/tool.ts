/**
 * pi 原生工具的公共部分（R2）。
 *
 * `NativeTool = AgentTool & { category }`：`category` 是**产品层字段**（权限策略要区分
 * read/write/exec/interact/mcp），不是对 pi 形状的翻译。
 * `ToolFailure`：pi 约定"失败即抛错"，抛出的错误会被 pi 记为工具错误结果；
 * `status` 供审计与界面区分语义（denied/timeout 不是技术错误）。
 */

import type { AgentTool } from '@earendil-works/pi-agent-core'

import type { ToolCategory } from '../../permissions/types'

export type NativeTool = AgentTool & { category: ToolCategory }

export class ToolFailure extends Error {
  constructor(
    message: string,
    readonly status: 'error' | 'denied' | 'timeout' = 'error',
  ) {
    super(message)
    this.name = 'ToolFailure'
  }
}

export interface ToolFactoryOptions {
  workspaceRoot: string
}
