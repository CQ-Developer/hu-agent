/**
 * 过渡期 MCP 工具桥（**R4 会删除本文件**）。
 *
 * 现状：MCP 客户端（`src/main/mcp/*`）还是自研的，产出的是旧 `AnyTool`（JSON Schema 参数 + `run`）。
 * 新引擎只吃 pi 原生 `AgentTool`。在 R4 用 `pi-mcp` 替换自研客户端之前，用这个桥把 MCP 工具
 * 临时接上新路径，避免"切换引擎"与"换 MCP"两件事互相阻塞。
 *
 * 明确标注为过渡件：R4 落地后本文件与其测试一并删除（ADR-0006 的删除清单已包含自研 MCP）。
 */

import { Type } from 'typebox'

import type { InteractionBroker } from '../permissions/broker'
import type { ArtifactStore } from '../session/artifacts'
import type { AnyTool } from './types'
import type { NativeTool } from './native/tool'

export interface McpBridgeContext {
  workspaceRoot: string
  sessionId: string
  turnId: string
  artifacts: ArtifactStore
  interactions: InteractionBroker
}

/** 旧 AnyTool（MCP）→ pi 原生工具；`execute` 里把 pi 的 signal 透传给 MCP 调用 */
export function bridgeLegacyTool(tool: AnyTool, context: McpBridgeContext): NativeTool {
  return {
    name: tool.name,
    label: tool.name,
    category: tool.category,
    description: tool.description,
    parameters: Type.Unsafe(tool.parameters as never),
    execute: async (_toolCallId, params, signal) => {
      const result = await tool.run(params ?? {}, {
        workspaceRoot: context.workspaceRoot,
        sessionId: context.sessionId,
        turnId: context.turnId,
        signal: signal ?? new AbortController().signal,
        artifacts: context.artifacts,
        interactions: context.interactions,
      })
      if (result.status !== 'ok') {
        throw Object.assign(new Error(result.output), { name: 'McpToolError', status: result.status })
      }
      return {
        content: [{ type: 'text' as const, text: result.output }],
        details: { status: result.status, ...(result.metadata ?? {}) },
      }
    },
  }
}

export function bridgeLegacyTools(tools: AnyTool[], context: McpBridgeContext): NativeTool[] {
  return tools.map((tool) => bridgeLegacyTool(tool, context))
}
