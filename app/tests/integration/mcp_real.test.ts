/** 真实 MCP server 联调（@modelcontextprotocol/server-filesystem，npx 拉起）。
 *
 * 默认跳过（需联网拉包）；显式运行：
 *   MCP_E2E=1 npx vitest run tests/integration/mcp-real.test.ts
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { McpManager } from '../../src/main/mcp/manager'
import type { WorkspacePaths } from '../../src/main/workspace'

class FakeSecrets {
  get(): string | null {
    return null
  }
  async set(): Promise<void> {}
}

const enabled = process.env.MCP_E2E === '1'

describe.skipIf(!enabled)('真实 MCP server（filesystem）', () => {
  let dir: string
  let manager: McpManager
  let workspace: WorkspacePaths

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-mcp-real-'))
    const root = join(dir, 'workspace')
    await mkdir(join(root, '.hu'), { recursive: true })
    await writeFile(join(root, 'hello.txt'), 'hello mcp', 'utf8')
    workspace = {
      id: 'ws_real',
      name: 'real',
      root,
      huDir: join(root, '.hu'),
      sessionDir: join(root, '.hu', 'sessions'),
      artifactDir: join(root, '.hu', 'sessions', 'artifacts'),
      auditFile: join(root, '.hu', 'logs', 'audit.jsonl'),
      settingsFile: join(root, '.hu', 'settings.json'),
    }
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify({
        servers: {
          filesystem: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', root],
            enabled: { global: true },
          },
        },
      }),
      'utf8',
    )
    manager = new McpManager(new FakeSecrets(), 'test', { globalFile: join(dir, 'mcp.json') })
  })

  afterAll(async () => {
    await manager?.closeAll()
    await rm(dir, { recursive: true, force: true })
  })

  it(
    '连接后能列出工具并读取文件内容',
    async () => {
      const tools = await manager.tools(workspace)
      const names = tools.map((tool) => tool.name)
      expect(names.length).toBeGreaterThan(0)
      const readTool = tools.find((tool) => tool.name === 'mcp__filesystem__read_text_file')
      expect(readTool).toBeDefined()

      const result = await readTool!.run({ path: join(workspace.root, 'hello.txt') }, {} as never)
      expect(result.status).toBe('ok')
      expect(result.output).toContain('hello mcp')

      const statuses = await manager.list(workspace)
      expect(statuses[0]).toMatchObject({ name: 'filesystem', status: 'connected' })
      console.log('filesystem 工具清单：', names.join(', '))
    },
    180_000,
  )
})
