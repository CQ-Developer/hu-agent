/** 权限引擎类型（design 5.5）。 */

export type ToolCategory = 'read' | 'write' | 'exec' | 'interact' | 'mcp'

export type PermissionAction = 'allow' | 'ask' | 'deny'

export type ApprovalChoice = 'allow_once' | 'allow_session' | 'allow_always' | 'deny'

export interface PolicyRule {
  tools: string[]
  /** 路径 glob；缺省表示匹配任意路径 */
  paths?: string[]
  action: PermissionAction
}

export interface PermissionCheck {
  workspaceRoot: string
  sessionId: string
  turnId: string
  toolCallId: string
  toolName: string
  category: ToolCategory
  input: Record<string, unknown>
}

export interface PermissionDecision {
  action: PermissionAction
  reason?: string
}

/** 路径非法（空、UNC、设备路径、Windows 保留名等）。 */
export class PermissionPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermissionPathError'
  }
}
