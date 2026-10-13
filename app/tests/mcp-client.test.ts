/** MCP stdio 客户端与管理器单测（design 5.8.2）：握手、分页、调用、命名空间、重连与回收。 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { McpStdioClient } from '../src/main/mcp/client'
import { McpManager } from '../src/main/mcp/manager'
import type { WorkspacePaths } from '../src/main/workspace'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.mjs')

class FakeSecrets {
  private readonly values = new Map<string, string>()
  get(key: string): string | null {
    return this.values.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

function fakeServer(command: string, args: string[] = [], enabled = true): Record<string, unknown> {
  return { command, args, transport: 'stdio', enabled: { global: enabled } }
}

describe('McpStdioClient', () => {
  let client: McpStdioClient | null = null

  afterEach(async () => {
    await client?.close()
    client = null
  })

  it('完成 initialize 握手并按分页取回工具，支持调用', async () => {
    client = new McpStdioClient('fake', { command: process.execPath, args: [FIXTURE], env: {} }, 'test')
    await client.connect()
    expect(client.isConnected).toBe(true)
    expect(client.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'ping'])

    const result = await client.callTool('echo', { text: '你好' })
    expect(result.isError).toBe(false)
    expect(result.content).toBe('echo:你好')
  })

  it('工具返回 JSON-RPC 错误时抛出错误信息', async () => {
    client = new McpStdioClient('fake', { command: process.execPath, args: [FIXTURE], env: {} }, 'test')
    await client.connect()
    await expect(client.callTool('fail', {})).rejects.toThrow('工具执行失败')
  })

  it('命令不存在时 connect 抛出错误', async () => {
    client = new McpStdioClient(
      'broken',
      { command: 'definitely-not-a-real-command-xyz', args: [], env: {} },
      'test',
    )
    await expect(client.connect()).rejects.toThrow()
  })
})

describe('McpManager', () => {
  let dir: string
  let workspace: WorkspacePaths
  let globalFile: string
  let manager: McpManager | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-mcp-manager-'))
    const root = join(dir, 'workspace')
    workspace = {
      id: 'ws_test',
      name: 'test',
      root,
      huDir: join(root, '.hu'),
      sessionDir: join(root, '.hu', 'sessions'),
      artifactDir: join(root, '.hu', 'sessions', 'artifacts'),
      auditFile: join(root, '.hu', 'logs', 'audit.jsonl'),
      settingsFile: join(root, '.hu', 'settings.json'),
    }
    globalFile = join(dir, 'mcp.json')
    await mkdir(join(root, '.hu'), { recursive: true })
  })

  afterEach(async () => {
    await manager?.closeAll()
    manager = null
    await rm(dir, { recursive: true, force: true })
  })

  it('注入工具使用 mcp__server__tool 命名并连接后返回工具', async () => {
    await writeFile(
      globalFile,
      JSON.stringify({ servers: { fake: fakeServer(process.execPath, [FIXTURE]) } }),
      'utf8',
    )
    manager = new McpManager(new FakeSecrets(), 'test', { globalFile, retryDelayMs: 10 })
    const tools = await manager.tools(workspace)
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__fake__echo', 'mcp__fake__ping'])
    expect(tools[0]?.description).toContain('MCP server：fake')
    expect(tools[0]?.category).toBe('mcp')

    const result = await tools[0]!.run({ text: 'hi' }, {} as never)
    expect(result.status).toBe('ok')
    expect(result.output).toBe('echo:hi')

    const status = await manager.list(workspace)
    expect(status[0]).toMatchObject({ name: 'fake', status: 'connected', toolCount: 2 })
  })

  it('未启用的 server 不连接也不注入工具', async () => {
    await writeFile(
      globalFile,
      JSON.stringify({ servers: { fake: fakeServer(process.execPath, [FIXTURE], false) } }),
      'utf8',
    )
    manager = new McpManager(new FakeSecrets(), 'test', { globalFile, retryDelayMs: 10 })
    expect(await manager.tools(workspace)).toEqual([])
    expect((await manager.list(workspace))[0]).toMatchObject({ status: 'disabled', enabled: false })
  })

  it('连接失败重试后记录错误状态，且不影响其他 server', async () => {
    await writeFile(
      globalFile,
      JSON.stringify({
        servers: {
          broken: { command: 'definitely-not-a-real-command-xyz', transport: 'stdio', enabled: { global: true } },
          fake: fakeServer(process.execPath, [FIXTURE]),
        },
      }),
      'utf8',
    )
    manager = new McpManager(new FakeSecrets(), 'test', { globalFile, retryDelayMs: 10 })
    const tools = await manager.tools(workspace)
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__fake__echo', 'mcp__fake__ping'])

    const statuses = await manager.list(workspace)
    expect(statuses.find((item) => item.name === 'broken')?.status).toBe('error')
    expect(statuses.find((item) => item.name === 'broken')?.lastError).toBeTruthy()

    const test = await manager.test(workspace, 'broken')
    expect(test.ok).toBe(false)
  })

  it('空闲超时回收连接，下次使用重新连接', async () => {
    await writeFile(
      globalFile,
      JSON.stringify({ servers: { fake: fakeServer(process.execPath, [FIXTURE]) } }),
      'utf8',
    )
    manager = new McpManager(new FakeSecrets(), 'test', { globalFile, retryDelayMs: 10, idleMs: 30 })
    await manager.tools(workspace)
    expect((await manager.list(workspace))[0]?.status).toBe('connected')

    await new Promise((resolve) => setTimeout(resolve, 60))
    await manager.reapIdle()
    expect((await manager.list(workspace))[0]?.status).toBe('idle')

    const tools = await manager.tools(workspace)
    expect(tools).toHaveLength(2)
  })
})
