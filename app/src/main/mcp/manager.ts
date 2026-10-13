/** MCP 管理器（design 5.8.2）：懒连接、失败重连退避、空闲回收、工具暴露。 */

import type { SecretReader } from './config'
import type { AnyTool } from '../tools/types'
import type { WorkspacePaths } from '../workspace'
import { McpStdioClient, type McpToolDefinition } from './client'
import {
  formatMcpSummary,
  globalMcpFile,
  isEnabledFor,
  loadMcpFile,
  mergeCatalog,
  resolveSecretValue,
  workspaceMcpFile,
  type McpApproval,
  type McpCatalogEntry,
  type McpServerConfig,
  type McpTransport,
} from './config'

export type McpStatus = 'disabled' | 'idle' | 'connecting' | 'connected' | 'error'

export interface McpServerStatus {
  name: string
  transport: McpTransport
  summary: string
  command?: string
  args: string[]
  url?: string
  env: Record<string, string>
  headers: Record<string, string>
  scope: McpCatalogEntry['scope']
  enabledGlobal: boolean
  enabledWorkspace: boolean
  enabled: boolean
  approval: McpApproval
  status: McpStatus
  toolCount: number
  lastError?: string
  envKeys: string[]
  headerKeys: string[]
  tools: { name: string; description: string }[]
}

export interface McpTestResult {
  ok: boolean
  toolCount: number
  error?: string
  tools: { name: string; description: string }[]
}

interface LiveEntry {
  key: string
  workspaceId: string
  client: McpStdioClient
  lastUsedAt: number
}

const DEFAULT_IDLE_MS = 10 * 60_000
const MAX_CONNECT_ATTEMPTS = 3
const DESCRIPTION_LIMIT = 1000
const DEFAULT_RETRY_DELAY_MS = 500

export interface McpManagerOptions {
  idleMs?: number
  /** 测试可注入；默认为 ~/.hu-agent/mcp.json */
  globalFile?: string
  retryDelayMs?: number
}

export class McpManager {
  private readonly live = new Map<string, LiveEntry>()
  private readonly connecting = new Set<string>()
  private readonly errors = new Map<string, string>()
  private readonly idleTimer: NodeJS.Timeout
  private readonly idleMs: number
  private readonly globalFile: string
  private readonly retryDelayMs: number

  constructor(
    private readonly secrets: SecretReader,
    private readonly clientVersion: string,
    options: McpManagerOptions = {},
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.globalFile = options.globalFile ?? globalMcpFile()
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    const interval = Math.min(60_000, Math.max(10_000, Math.floor(this.idleMs / 2)))
    this.idleTimer = setInterval(() => void this.reapIdle(), interval)
    this.idleTimer.unref?.()
  }

  /** 配置与运行状态（不触发连接）。 */
  async list(ws: WorkspacePaths): Promise<McpServerStatus[]> {
    const catalog = await this.catalog(ws)
    return catalog.map((entry) => {
      const key = keyOf(ws, entry.name)
      const live = this.live.get(key)
      const enabled = isEnabledFor(entry.config, ws.id)
      const status: McpStatus = !enabled
        ? 'disabled'
        : this.connecting.has(key)
          ? 'connecting'
          : live?.client.isConnected
            ? 'connected'
            : this.errors.has(key)
              ? 'error'
              : 'idle'
      const tools = live?.client.tools ?? []
      return {
        name: entry.name,
        transport: entry.config.transport ?? 'stdio',
        summary: formatMcpSummary(entry.config),
        command: entry.config.command,
        args: entry.config.args ?? [],
        url: entry.config.url,
        env: entry.config.env ?? {},
        headers: entry.config.headers ?? {},
        scope: entry.scope,
        enabledGlobal: Boolean(entry.config.enabled?.global),
        enabledWorkspace: (entry.config.enabled?.workspaces ?? []).includes(ws.id),
        enabled,
        approval: entry.config.approval ?? 'ask',
        status,
        toolCount: tools.length,
        lastError: this.errors.get(key),
        envKeys: Object.keys(entry.config.env ?? {}),
        headerKeys: Object.keys(entry.config.headers ?? {}),
        tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' })),
      }
    })
  }

  /** 连接全部启用 server，返回注入模型的工具（单个失败不影响其他 server）。 */
  async tools(ws: WorkspacePaths): Promise<AnyTool[]> {
    const catalog = await this.catalog(ws)
    const results = await Promise.all(
      catalog
        .filter((entry) => isEnabledFor(entry.config, ws.id))
        .map((entry) => this.toolsForEntry(ws, entry)),
    )
    return results.flat().sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 强制重连并返回工具清单（供「测试连接」使用）。 */
  async test(ws: WorkspacePaths, name: string): Promise<McpTestResult> {
    const catalog = await this.catalog(ws)
    const entry = catalog.find((item) => item.name === name)
    if (!entry) return { ok: false, toolCount: 0, error: `未找到 MCP server：${name}`, tools: [] }
    await this.dropEntry(ws, name)
    const client = await this.ensure(ws, entry)
    if (!client) {
      return { ok: false, toolCount: 0, error: this.errors.get(keyOf(ws, name)) ?? '连接失败', tools: [] }
    }
    const tools = client.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' }))
    return { ok: true, toolCount: tools.length, tools }
  }

  /** 配置变更后清空对应工作空间的连接与错误状态。 */
  async reload(ws: WorkspacePaths): Promise<void> {
    const names = [...this.live.values()]
      .filter((entry) => entry.workspaceId === ws.id)
      .map((entry) => entry.key)
    for (const key of names) await this.closeKey(key)
    for (const key of [...this.errors.keys()]) {
      if (key.startsWith(`${ws.id}\u0000`)) this.errors.delete(key)
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.idleTimer)
    for (const key of [...this.live.keys()]) await this.closeKey(key)
    this.errors.clear()
    this.connecting.clear()
  }

  private async catalog(ws: WorkspacePaths): Promise<McpCatalogEntry[]> {
    const [globalServers, workspaceServers] = await Promise.all([
      loadMcpFile(this.globalFile),
      loadMcpFile(workspaceMcpFile(ws)),
    ])
    return mergeCatalog(globalServers, workspaceServers)
  }

  private async toolsForEntry(ws: WorkspacePaths, entry: McpCatalogEntry): Promise<AnyTool[]> {
    const client = await this.ensure(ws, entry)
    if (!client) return []
    return client.tools.map((definition) => buildMcpTool(entry.name, definition, client))
  }

  private async ensure(ws: WorkspacePaths, entry: McpCatalogEntry): Promise<McpStdioClient | null> {
    const key = keyOf(ws, entry.name)
    const existing = this.live.get(key)
    if (existing?.client.isConnected) {
      existing.lastUsedAt = Date.now()
      return existing.client
    }

    const transport = entry.config.transport ?? 'stdio'
    if (transport !== 'stdio') {
      this.errors.set(key, `暂不支持 ${transport} 传输（计划阶段 3-05）`)
      return null
    }
    const command = entry.config.command
    if (!command) {
      this.errors.set(key, '缺少 command 配置')
      return null
    }

    this.connecting.add(key)
    try {
      let lastError = '连接失败'
      for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
        const client = new McpStdioClient(
          entry.name,
          { command, args: entry.config.args ?? [], env: this.resolveEnv(entry) },
          this.clientVersion,
        )
        try {
          await client.connect()
          this.live.set(key, { key, workspaceId: ws.id, client, lastUsedAt: Date.now() })
          this.errors.delete(key)
          return client
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          await client.close()
          if (attempt < MAX_CONNECT_ATTEMPTS) await sleep(attempt * this.retryDelayMs)
        }
      }
      this.errors.set(key, lastError)
      return null
    } finally {
      this.connecting.delete(key)
    }
  }

  private resolveEnv(entry: McpCatalogEntry): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [name, ref] of Object.entries(entry.config.env ?? {})) {
      const value = resolveSecretValue(ref, this.secrets)
      if (value !== null) env[name] = value
    }
    return env
  }

  private async dropEntry(ws: WorkspacePaths, name: string): Promise<void> {
    await this.closeKey(keyOf(ws, name))
  }

  private async closeKey(key: string): Promise<void> {
    const entry = this.live.get(key)
    this.live.delete(key)
    if (entry) await entry.client.close()
  }

  /** 空闲回收；由内部定时器调用，测试可直接触发。 */
  async reapIdle(): Promise<void> {    const now = Date.now()
    for (const [key, entry] of [...this.live]) {
      if (!entry.client.isConnected || now - entry.lastUsedAt > this.idleMs) await this.closeKey(key)
    }
  }
}

function keyOf(ws: WorkspacePaths, name: string): string {
  return `${ws.id}\u0000${name}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 工具统一命名 mcp__<server>__<tool>（design 5.8.2），描述截断到 1000 字符。 */
function buildMcpTool(server: string, definition: McpToolDefinition, client: McpStdioClient): AnyTool {
  const description = definition.description?.trim() ?? ''
  return {
    name: `mcp__${sanitize(server)}__${sanitize(definition.name)}`,
    description: `${description ? `${description} · ` : ''}MCP server：${server}`.slice(0, DESCRIPTION_LIMIT),
    category: 'mcp',
    parameters: isObject(definition.inputSchema) ? definition.inputSchema : { type: 'object', properties: {} },
    run: async (input, ctx) => {
      try {
        const result = await client.callTool(definition.name, (input ?? {}) as Record<string, unknown>, ctx.signal)
        return { status: result.isError ? 'error' : 'ok', output: result.content }
      } catch (error) {
        return { status: 'error', output: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { McpServerConfig }
