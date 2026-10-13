/** 工具注册表（design 5.4.1）。 */

import type { ToolDefinitionForModel } from '../model/types'
import { askGuideTool } from './ask-guide'
import { editFileTool } from './edit-file'
import { readFileTool } from './read-file'
import { bashTool, powershellTool } from './shell'
import { toModelTool, type AnyTool } from './types'
import { writeFileTool } from './write-file'

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>()

  constructor(tools: AnyTool[]) {
    for (const tool of tools) this.tools.set(tool.name, tool)
  }

  get(name: string): AnyTool | undefined {
    return this.tools.get(name)
  }

  list(): AnyTool[] {
    return [...this.tools.values()]
  }

  toModelTools(): ToolDefinitionForModel[] {
    return this.list().map(toModelTool)
  }
}

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([readFileTool, writeFileTool, editFileTool, bashTool, powershellTool, askGuideTool])
}
