/** 权限引擎：硬规则 -> 规则匹配 -> 默认策略 -> 会话授权 -> 授权卡片（design 5.5）。 */

import type { AuditLog } from './audit'
import type { InteractionBroker } from './broker'
import { canonicalizePath, isProtectedWritePath, isSensitivePath, matchesAnyPattern } from './paths'
import type { PermissionCheck, PermissionDecision, PolicyRule, ToolCategory } from './types'

export interface EngineDeps {
  workspaceRoot: string
  /** 工作空间规则（allow_always 会追加到最前） */
  rules: PolicyRule[]
  globalRules: PolicyRule[]
  /** sessionId -> 授权 scope 集合（本会话有效） */
  grants: Map<string, Set<string>>
  broker: InteractionBroker
  audit: AuditLog
  persistRule: (rule: PolicyRule) => Promise<void>
}

interface ResolvedPath {
  absolute: string
  insideWorkspace: boolean
}

export class PermissionEngine {
  constructor(private readonly deps: EngineDeps) {}

  async check(check: PermissionCheck): Promise<PermissionDecision> {
    let paths: ResolvedPath[]
    try {
      paths = await this.resolvePaths(check)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.record(check, 'deny', reason)
      return { action: 'deny', reason }
    }
    const summary = this.summarize(check, paths)

    // 内置硬规则（不可覆盖）
    for (const path of paths) {
      if (isSensitivePath(path.absolute, this.deps.workspaceRoot)) {
        const reason = `敏感路径拒绝访问：${path.absolute}`
        await this.record(check, 'deny', reason)
        return { action: 'deny', reason }
      }
    }
    if (check.category === 'write') {
      for (const path of paths) {
        if (isProtectedWritePath(path.absolute, this.deps.workspaceRoot)) {
          const reason = `保护文件不可写入，请在设置界面修改：${path.absolute}`
          await this.record(check, 'deny', reason)
          return { action: 'deny', reason }
        }
      }
    }

    const matched = this.matchRules(check, paths)
    const action = matched ?? this.defaultAction(check, paths)

    if (action === 'allow') {
      await this.record(check, 'allow', '策略允许')
      return { action: 'allow' }
    }
    if (action === 'deny') {
      await this.record(check, 'deny', '策略拒绝')
      return { action: 'deny', reason: '当前权限策略拒绝该操作' }
    }

    // ask：先看会话内已有授权
    const scope = this.scopeOf(check, paths)
    if (this.isGranted(check.sessionId, check.toolName, scope)) {
      await this.record(check, 'allow_session', scope)
      return { action: 'allow' }
    }

    const choice = await this.deps.broker.requestApproval({
      sessionId: check.sessionId,
      turnId: check.turnId,
      toolName: check.toolName,
      category: check.category,
      summary,
      paths: paths.map((path) => path.absolute),
      command: typeof check.input.command === 'string' ? check.input.command : undefined,
      scopeHint: paths.length > 0 ? `允许访问 ${paths[0]?.absolute ?? ''}` : `始终允许 ${check.toolName}`,
    })

    if (choice === 'deny') {
      await this.record(check, 'deny', '用户拒绝', check.toolCallId)
      return { action: 'deny', reason: '用户拒绝了该操作' }
    }
    if (choice === 'allow_session') this.grant(check.sessionId, scope)
    if (choice === 'allow_always') {
      this.grant(check.sessionId, scope)
      const rule = this.ruleFor(check, paths)
      this.deps.rules.unshift(rule)
      await this.deps.persistRule(rule)
    }
    await this.record(check, choice, scope)
    return { action: 'allow' }
  }

  private async resolvePaths(check: PermissionCheck): Promise<ResolvedPath[]> {
    const raw: string[] = []
    const kind = check.category
    if (kind === 'read' || kind === 'write') {
      if (typeof check.input.path === 'string') raw.push(check.input.path)
    } else if (kind === 'exec') {
      if (typeof check.input.cwd === 'string' && check.input.cwd) raw.push(check.input.cwd)
      else raw.push(this.deps.workspaceRoot)
    }
    const resolved: ResolvedPath[] = []
    for (const item of raw) {
      resolved.push(await canonicalizePath(item, this.deps.workspaceRoot))
    }
    return resolved
  }

  private summarize(check: PermissionCheck, paths: ResolvedPath[]): string {
    if (typeof check.input.command === 'string') return check.input.command
    if (paths.length > 0) return paths.map((path) => path.absolute).join(', ')
    return check.toolName
  }

  private matchRules(check: PermissionCheck, paths: ResolvedPath[]): 'allow' | 'ask' | 'deny' | null {
    for (const rule of [...this.deps.rules, ...this.deps.globalRules]) {
      const toolMatches = rule.tools.includes('*') || rule.tools.includes(check.toolName)
      if (!toolMatches) continue
      if (rule.paths && rule.paths.length > 0) {
        const hit = paths.some((path) =>
          rule.paths?.some((pattern) => matchesAnyPattern(path.absolute, [pattern], this.deps.workspaceRoot)),
        )
        if (!hit) continue
      }
      return rule.action
    }
    return null
  }

  private defaultAction(check: PermissionCheck, paths: ResolvedPath[]): 'allow' | 'ask' {
    switch (check.category) {
      case 'interact':
        return 'allow'
      case 'read':
      case 'write':
        // 工作空间内允许；越界询问（design 5.5.3 Balanced）
        return paths.every((path) => path.insideWorkspace) ? 'allow' : 'ask'
      case 'exec':
      case 'mcp':
      default:
        return 'ask'
    }
  }

  private scopeOf(check: PermissionCheck, paths: ResolvedPath[]): string {
    if (paths.length > 0) return `tool:${check.toolName}:path:${paths[0]?.absolute ?? ''}`
    return `tool:${check.toolName}:any`
  }

  private isGranted(sessionId: string, toolName: string, scope: string): boolean {
    const grants = this.deps.grants.get(sessionId)
    if (!grants) return false
    return grants.has(scope) || grants.has(`tool:${toolName}:any`)
  }

  private grant(sessionId: string, scope: string): void {
    const grants = this.deps.grants.get(sessionId) ?? new Set<string>()
    grants.add(scope)
    this.deps.grants.set(sessionId, grants)
  }

  private ruleFor(check: PermissionCheck, paths: ResolvedPath[]): PolicyRule {
    if (paths.length > 0) {
      return { tools: [check.toolName], paths: [paths[0]?.absolute ?? ''], action: 'allow' }
    }
    return { tools: [check.toolName], action: 'allow' }
  }

  private async record(
    check: PermissionCheck,
    decision: 'allow' | 'deny' | 'allow_once' | 'allow_session' | 'allow_always',
    scope: string,
    toolCallId?: string,
  ): Promise<void> {
    await this.deps.audit.record({
      sessionId: check.sessionId,
      turnId: check.turnId,
      toolCallId: toolCallId ?? check.toolCallId,
      tool: check.toolName,
      summary: this.summarize(check, []),
      decision,
      scope,
      args: check.input,
    })
  }
}

export const CATEGORY_OF_TOOL: Record<string, ToolCategory> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'write',
  bash: 'exec',
  powershell: 'exec',
  ask_guide: 'interact',
}
