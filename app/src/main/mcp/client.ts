/** MCP stdio 客户端（design 5.8.2）：换行分隔 JSON-RPC 2.0。
 *
 * 覆盖 initialize 握手、tools/list 分页、tools/call、取消通知与服务端请求应答；
 * 进程退出/无法连接时向上抛出错误，由 McpManager 负责重连与状态展示。
 */

import { spawn, type ChildProcess } from 'node:child_process'

import { terminateTree } from '../tools/shell'

export interface McpToolDefinition {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpCallResult {
  content: string
  isError: boolean
}

export interface McpStdioOptions {
  command: string
  args: string[]
  env: Record<string, string>
}

const CONNECT_TIMEOUT_MS = 60_000
const CALL_TIMEOUT_MS = 120_000
const STDERR_LIMIT = 8 * 1024
const MAX_TOOL_PAGES = 20
export const MCP_PROTOCOL_VERSION = '2025-06-18'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  cleanup: () => void
}

export class McpStdioClient {
  private child: ChildProcess | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private stderrTail = ''
  private connected = false
  private toolsChanged = false
  private toolCache: McpToolDefinition[] = []
  private serverInfo: { name?: string; version?: string } = {}

  constructor(
    private readonly serverName: string,
    private readonly options: McpStdioOptions,
    private readonly clientVersion: string,
  ) {}

  get isConnected(): boolean {
    return this.connected
  }

  get tools(): McpToolDefinition[] {
    return this.toolCache
  }

  get info(): { name?: string; version?: string } {
    return this.serverInfo
  }

  get stderr(): string {
    return this.stderrTail.trim()
  }

  async connect(): Promise<void> {
    await this.close()
    this.connected = false
    this.buffer = ''
    this.stderrTail = ''
    const child = spawnMcpProcess(this.options)
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-STDERR_LIMIT)
    })
    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk))
    child.on('error', (error) => this.failAll(`MCP 进程启动失败：${error.message}`))
    child.on('exit', (code, signal) => {
      this.connected = false
      this.failAll(`MCP 进程退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${this.stderr ? `：${this.stderr}` : ''}`)
    })

    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'hu-agent', version: this.clientVersion },
    })) as { serverInfo?: { name?: string; version?: string } }
    this.serverInfo = result.serverInfo ?? {}
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    this.connected = true
    await this.listTools()
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: unknown[]
        nextCursor?: string
      }
      for (const item of result.tools ?? []) {
        const tool = normalizeTool(item)
        if (tool) tools.push(tool)
      }
      if (!result.nextCursor) break
      cursor = result.nextCursor
    }
    this.toolCache = tools
    this.toolsChanged = false
    return tools
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    if (this.toolsChanged) await this.listTools()
    const result = (await this.request('tools/call', { name, arguments: args }, signal)) as {
      content?: unknown[]
      isError?: boolean
    }
    return { content: formatContent(result.content), isError: Boolean(result.isError) }
  }

  async close(): Promise<void> {
    this.connected = false
    this.failAll('MCP 连接已关闭')
    const child = this.child
    this.child = null
    if (child && !child.killed) {
      terminateTree(child)
      // 给进程树一点退出时间，避免 npx 子进程残留
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('MCP 进程未启动'))
    const id = this.nextId
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const detail = this.stderr ? `：${this.stderr}` : ''
        reject(new Error(`MCP 请求超时：${method}（${this.serverName}）${detail}`))
      }, method === 'tools/call' ? CALL_TIMEOUT_MS : CONNECT_TIMEOUT_MS)
      const onAbort = (): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'user' } })
        reject(new Error('已取消'))
      }
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort)
      if (signal) {
        if (signal.aborted) {
          reject(new Error('已取消'))
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          cleanup()
          reject(error)
        },
        timer,
        cleanup,
      })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private send(message: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(message)}\n`)
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try {
        this.handleMessage(JSON.parse(line) as Record<string, unknown>)
      } catch {
        // 非 JSON 输出（部分 server 会打日志到 stdout）：忽略
      }
    }
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      pending.cleanup()
      if (message.error) {
        const error = message.error as { message?: string; code?: number }
        pending.reject(new Error(`MCP 错误：${error.message ?? JSON.stringify(message.error)}`))
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method === 'string' && message.id !== undefined) {
      // 服务端发起的请求：只应答 ping，其余明确拒绝
      if (message.method === 'ping') this.send({ jsonrpc: '2.0', id: message.id, result: {} })
      else {
        this.send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `不支持的服务端请求：${message.method}` },
        })
      }
      return
    }
    if (message.method === 'notifications/tools/list_changed') this.toolsChanged = true
  }

  private failAll(reason: string): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.cleanup()
      pending.reject(new Error(reason))
    }
  }
}

function spawnMcpProcess(options: McpStdioOptions): ChildProcess {
  const env = { ...process.env, ...options.env }
  if (process.platform === 'win32') {
    // Windows 上 npx/uvx 等是 .cmd 包装，必须经 cmd.exe 解析
    const line = [options.command, ...options.args].map(quoteWindowsArg).join(' ')
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }
  return spawn(options.command, options.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

function quoteWindowsArg(arg: string): string {
  if (arg.length === 0) return '""'
  if (!/[ \t"&|<>^()%!]/.test(arg)) return arg
  return `"${arg.replace(/"/g, '\\"')}"`
}

function normalizeTool(value: unknown): McpToolDefinition | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { name?: unknown; description?: unknown; inputSchema?: unknown }
  if (typeof record.name !== 'string' || record.name.length === 0) return null
  return {
    name: record.name,
    description: typeof record.description === 'string' ? record.description : undefined,
    inputSchema: record.inputSchema,
  }
}

function formatContent(content: unknown[] | undefined): string {
  if (!Array.isArray(content) || content.length === 0) return '(无输出)'
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as { type?: string; text?: string; mimeType?: string; uri?: string; data?: string }
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (record.type === 'image') parts.push(`[图片 ${record.mimeType ?? 'unknown'}]`)
    else if (record.type === 'resource') parts.push(`[资源 ${record.uri ?? ''}]`)
    else parts.push(JSON.stringify(item))
  }
  return parts.join('\n')
}
