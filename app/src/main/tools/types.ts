/** 工具接口（design 5.4.1）。 */

import type { ToolDefinitionForModel } from '../model/types'
import type { ArtifactStore } from '../session/artifacts'
import type { ToolStatus } from '../session/types'

export interface ToolContext {
  workspaceRoot: string
  sessionId: string
  turnId: string
  signal: AbortSignal
  artifacts: ArtifactStore
}

export interface ToolResult {
  status: ToolStatus
  output: string
  metadata?: { durationMs?: number; exitCode?: number; bytes?: number }
}

export interface ToolDef<I = Record<string, unknown>> {
  name: string
  description: string
  parameters: Record<string, unknown>
  run(input: I, ctx: ToolContext): Promise<ToolResult>
}

/** 注册表使用的存在类型：入参类型在 defineTool 内部被擦除。 */
export interface AnyTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  run(input: unknown, ctx: ToolContext): Promise<ToolResult>
}

export function defineTool<I>(tool: ToolDef<I>): AnyTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    run: (input, ctx) => tool.run(input as I, ctx),
  }
}

export function toModelTool(tool: AnyTool): ToolDefinitionForModel {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}
