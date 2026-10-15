/** MCP 管理器（design 5.8.2）：懒连接、失败重连退避、空闲回收、工具暴露。
 *
 * R4：客户端换成 pi 的原生实现 `@earendil-works/pi-mcp`（自研 288 行 client.ts 已删除），
 * 并顺带支持 streamable HTTP 传输（此前只支持 stdio，v1.x 计划里的 MCP http/sse 由此解决）。
 * 工具直接产出 pi 原生 `NativeTool`（MCP 工具 → AgentTool 的官方配方见 pi-mcp README），
 * 因此不再需要过渡期的 tools/mcp_bridge.ts。
 */

import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp'
import { Type } from 'typebox'

import type { SecretReader } from './config'
import type { WorkspacePaths } from '../workspace'
import { ToolFailure, type NativeTool } from '../tools/native/tool'
import {
  formatMcpSummary,
  globalMcpFile,
  isEnabledFor,
  isSecretRef,
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
  client: McpClient
  tools: Array<{ name: string; description?: string; title?: string; inputSchema: Record<string, unknown> }>
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
  /** 市场来源资源被服务端硬停用时返回 true：不连接、不注入工具（design 5.12） */
  isBlocked?: (entry: McpCatalogEntry) => boolean
}

export class McpManager {
  private readonly live = new Map<string, LiveEntry>()
  private readonly connecting = new Set<string>()
  private readonly errors = new Map<string, string>()
  private readonly idleTimer: NodeJS.Timeout
  private readonly idleMs: number
  private readonly globalFile: string
  private readonly retryDelayMs: number
  private readonly isBlocked: ((entry: McpCatalogEntry) => boolean) | undefined

  constructor(
    private readonly secrets: SecretReader,
    private readonly clientVersion: string,
    options: McpManagerOptions = {},
  ) {
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS
    this.globalFile = options.globalFile ?? globalMcpFile()
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    this.isBlocked = options.isBlocked
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
      const enabled = isEnabledFor(entry.config, ws.id) && !this.isBlocked?.(entry)
      const status: McpStatus = !enabled
        ? 'disabled'
        : this.connecting.has(key)
          ? 'connecting'
          : live
            ? 'connected'
            : this.errors.has(key)
              ? 'error'
              : 'idle'
      const tools = live?.tools ?? []
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

  /** 连接全部启用 server，返回注入模型的 pi 原生工具（单个失败不影响其他 server）。 */
  async tools(ws: WorkspacePaths): Promise<NativeTool[]> {
    const catalog = await this.catalog(ws)
    const results = await Promise.all(
      catalog
        .filter((entry) => isEnabledFor(entry.config, ws.id))
        .filter((entry) => !this.isBlocked?.(entry))
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
    const live = await this.ensure(ws, entry)
    if (!live) {
      return { ok: false, toolCount: 0, error: this.errors.get(keyOf(ws, name)) ?? '连接失败', tools: [] }
    }
    const tools = live.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '' }))
    return { ok: true, toolCount: tools.length, tools }
  }

  /** 配置变更后清空对应工作空间的连接与错误状态。 */
  async reload(ws: WorkspacePaths): Promise<void> {
    const names = [...this.live.values()].filter((entry) => entry.workspaceId === ws.id).map((entry) => entry.key)
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

  /** 空闲回收；由内部定时器调用，测试可直接触发。 */
  async reapIdle(): Promise<void> {
    const now = Date.now()
    for (const [key, entry] of [...this.live]) {
      if (now - entry.lastUsedAt > this.idleMs) await this.closeKey(key)
    }
  }

  private async catalog(ws: WorkspacePaths): Promise<McpCatalogEntry[]> {
    const [globalServers, workspaceServers] = await Promise.all([
      loadMcpFile(this.globalFile),
      loadMcpFile(workspaceMcpFile(ws)),
    ])
    return mergeCatalog(globalServers, workspaceServers)
  }

  private async toolsForEntry(ws: WorkspacePaths, entry: McpCatalogEntry): Promise<NativeTool[]> {
    const live = await this.ensure(ws, entry)
    if (!live) return []
    return live.tools.map((definition) => buildMcpTool(entry.name, definition, live.client))
  }

  private async ensure(ws: WorkspacePaths, entry: McpCatalogEntry): Promise<LiveEntry | null> {
    const key = keyOf(ws, entry.name)
    const existing = this.live.get(key)
    if (existing) {
      existing.lastUsedAt = Date.now()
      return existing
    }

    const transport = entry.config.transport ?? 'stdio'
    if (transport === 'stdio' && !entry.config.command) {
      this.errors.set(key, '缺少 command 配置')
      return null
    }
    if (transport !== 'stdio' && !entry.config.url) {
      this.errors.set(key, '缺少 url 配置')
      return null
    }

    this.connecting.add(key)
    try {
      let lastError = '连接失败'
      for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt += 1) {
        const client = new McpClient({ name: 'hu-agent', version: this.clientVersion })
        try {
          await client.connect(this.buildTransport(entry, transport))
          const tools = await client.listTools()
          const live: LiveEntry = { key, workspaceId: ws.id, client, tools, lastUsedAt: Date.now() }
          this.live.set(key, live)
          this.errors.delete(key)
          return live
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error)
          await client.close().catch(() => undefined)
          if (attempt < MAX_CONNECT_ATTEMPTS) await sleep(attempt * this.retryDelayMs)
        }
      }
      this.errors.set(key, lastError)
      return null
    } finally {
      this.connecting.delete(key)
    }
  }

  private buildTransport(
    entry: McpCatalogEntry,
    transport: McpTransport,
  ): StdioTransport | StreamableHttpTransport {
    if (transport === 'stdio') {
      return new StdioTransport({
        command: entry.config.command ?? '',
        args: entry.config.args ?? [],
        env: this.resolveEnv(entry),
      })
    }
    return new StreamableHttpTransport({
      url: entry.config.url ?? '',
      ...(Object.keys(entry.config.headers ?? {}).length > 0
        ? { headers: this.resolveHeaders(entry) }
        : {}),
    })
  }

  private resolveEnv(entry: McpCatalogEntry): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(entry.config.env ?? {})) {
      const resolved = resolveMaybeSecret(value, this.secrets)
      if (resolved !== null) env[name] = resolved
    }
    return env
  }

  private resolveHeaders(entry: McpCatalogEntry): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(entry.config.headers ?? {})) {
      const resolved = resolveMaybeSecret(value, this.secrets)
      if (resolved !== null) headers[name] = resolved
    }
    return headers
  }

  private async dropEntry(ws: WorkspacePaths, name: string): Promise<void> {
    await this.closeKey(keyOf(ws, name))
  }

  private async closeKey(key: string): Promise<void> {
    const entry = this.live.get(key)
    this.live.delete(key)
    if (entry) await entry.client.close().catch(() => undefined)
  }
}

function keyOf(ws: WorkspacePaths, name: string): string {
  return `${ws.id}\u0000${name}`
}

/** 密钥引用解析为真实值；非引用（手工/市场安装的明文配置）原样通过。 */
function resolveMaybeSecret(value: string, secrets: SecretReader): string | null {
  return isSecretRef(value) ? resolveSecretValue(value, secrets) : value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type McpToolDefinition = LiveEntry['tools'][number]

/** 工具统一命名 mcp__<server>__<tool>（design 5.8.2），描述截断到 1000 字符。 */
function buildMcpTool(server: string, definition: McpToolDefinition, client: McpClient): NativeTool {
  const description = definition.description?.trim() ?? ''
  const schema = definition.inputSchema ?? {}
  return {
    name: `mcp__${sanitize(server)}__${sanitize(definition.name)}`,
    label: definition.title ?? definition.name,
    category: 'mcp',
    description: `${description ? `${description} · ` : ''}MCP server：${server}`.slice(0, DESCRIPTION_LIMIT),
    // 部分 provider 要求参数是对象且带 properties（pi-mcp README 的官方配方）
    parameters: Type.Unsafe({ ...schema, type: 'object', properties: isObject(schema.properties) ? schema.properties : {} }),
    execute: async (_toolCallId, params, signal) => {
      const result = await client
        .callTool(definition.name, (params ?? {}) as Record<string, unknown>, {
          ...(signal ? { signal } : {}),
        })
        .catch((error: unknown) => {
          // 传输/协议层失败：按 pi 约定抛错（工具级失败在 result.isError 里）
          throw new ToolFailure(error instanceof Error ? error.message : String(error))
        })
      return {
        content: toLlmContent(result),
        details: { status: result.isError ? 'error' : 'ok', tool: definition.name },
        isError: result.isError === true,
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
