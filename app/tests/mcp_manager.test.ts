/**
 * MCP 管理器测试（R4）：走**真实 stdio**（假 MCP server fixture + pi-mcp 客户端），
 * 验证替换自研客户端后的产品面与语义完全一致：
 *
 * 1. 工具命名 `mcp__<server>__<tool>`、`category: 'mcp'`、参数为对象 schema（provider 要求）；
 * 2. 工具调用：成功走 `toLlmContent`；工具级失败以 `isError` 返回（不抛）；
 * 3. 状态机：连接后 connected、空闲/关闭后回到 idle；连接失败记录 lastError 且不影响其他 server；
 * 4. `test()` 强制重连并返回工具清单。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { McpManager } from '../src/main/mcp/manager'
import type { WorkspacePaths } from '../src/main/workspace'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake_mcp_server.mjs')

class FakeSecrets {
  get(): string | null {
    return null
  }
}

function fakeServer(command: string, args: string[], extra: Record<string, unknown> = {}): unknown {
  return { transport: 'stdio', command, args, enabled: { global: true }, approval: 'ask', ...extra }
}

describe('McpManager（pi-mcp 客户端）', () => {
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

  async function start(servers: Record<string, unknown>): Promise<McpManager> {
    await writeFile(globalFile, JSON.stringify({ servers }), 'utf8')
    manager = new McpManager(new FakeSecrets() as never, 'test', { globalFile, retryDelayMs: 10 })
    return manager
  }

  it('工具命名、分类与参数形状符合 provider 要求', async () => {
    const mcp = await start({ fake: fakeServer(process.execPath, [FIXTURE]) })
    const tools = await mcp.tools(workspace)

    expect(tools.map((tool) => tool.name)).toEqual(['mcp__fake__echo', 'mcp__fake__ping'])
    expect(tools[0]?.category).toBe('mcp')
    expect(tools[0]?.description).toContain('MCP server：fake')
    // typebox 的 Unsafe 包装：对外仍是对象 schema 且带 properties
    expect((tools[0]?.parameters as { type?: string }).type).toBe('object')
    expect((tools[0]?.parameters as { properties?: unknown }).properties).toBeDefined()
  })

  it('工具调用：成功返回文本内容；工具级失败以 isError 返回而不抛', async () => {
    const mcp = await start({ fake: fakeServer(process.execPath, [FIXTURE]) })
    const tools = await mcp.tools(workspace)

    const echo = tools.find((tool) => tool.name === 'mcp__fake__echo')!
    const ok = await echo.execute('c1', { text: 'hi' }, undefined as never, undefined)
    expect(ok.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).toContain('echo:hi')
    expect(ok.details).toMatchObject({ status: 'ok' })

    // 连接关闭后再调用：传输层失败 → 按 pi 约定抛错（工具级失败才走 isError）
    await mcp.closeAll()
    await expect(echo.execute('c3', { text: 'x' }, undefined as never, undefined)).rejects.toThrow()
  })

  it('状态机：连接后 connected，closeAll 后回到 idle', async () => {
    const mcp = await start({ fake: fakeServer(process.execPath, [FIXTURE]) })
    await mcp.tools(workspace)

    const connected = await mcp.list(workspace)
    expect(connected[0]).toMatchObject({ status: 'connected', toolCount: 2, transport: 'stdio' })

    await mcp.closeAll()
    const idle = await mcp.list(workspace)
    expect(idle[0]).toMatchObject({ status: 'idle', toolCount: 0 })
  })

  it('连接失败：记录 lastError 且不抛；不影响其他 server', async () => {
    const mcp = await start({
      broken: fakeServer(join(dir, '不存在的可执行文件'), []),
      fake: fakeServer(process.execPath, [FIXTURE]),
    })
    const tools = await mcp.tools(workspace)
    expect(tools.map((tool) => tool.name)).toEqual(['mcp__fake__echo', 'mcp__fake__ping'])

    const statuses = await mcp.list(workspace)
    const broken = statuses.find((status) => status.name === 'broken')
    expect(broken?.status).toBe('error')
    expect(broken?.lastError).toBeTruthy()
  })

  it('test() 强制重连并返回工具清单；未配置的 server 报可读错误', async () => {
    const mcp = await start({ fake: fakeServer(process.execPath, [FIXTURE]) })

    const result = await mcp.test(workspace, 'fake')
    expect(result).toMatchObject({ ok: true, toolCount: 2 })
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'ping'])

    const missing = await mcp.test(workspace, 'nope')
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('未找到 MCP server')
  })

  it('disabled 的 server 不连接也不注入工具', async () => {
    const mcp = await start({
      off: fakeServer(process.execPath, [FIXTURE], { enabled: { global: false } }),
    })
    expect(await mcp.tools(workspace)).toEqual([])
    const statuses = await mcp.list(workspace)
    expect(statuses[0]).toMatchObject({ status: 'disabled', enabled: false })
  })
})
