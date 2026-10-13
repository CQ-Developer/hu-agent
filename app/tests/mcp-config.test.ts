/** MCP 配置合并、启停判定与密钥引用单测（design 5.8.1）。 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  isEnabledFor,
  materializeSecrets,
  mergeCatalog,
  mergeConfig,
  resolveSecretValue,
  saveMcpServer,
  type McpServerConfig,
} from '../src/main/mcp/config'

class FakeSecrets {
  private readonly values = new Map<string, string>()
  get(key: string): string | null {
    return this.values.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

describe('MCP 配置', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-mcp-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('工作空间按字段覆盖全局，enabled.workspaces 取并集', () => {
    const global: McpServerConfig = {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      env: { A: 'secret://keychain/hu-agent/a' },
      enabled: { global: true, workspaces: ['ws_a'] },
      approval: 'ask',
    }
    const workspace: McpServerConfig = {
      env: { B: 'secret://keychain/hu-agent/b' },
      enabled: { workspaces: ['ws_b'] },
    }
    const merged = mergeConfig(global, workspace)
    expect(merged.command).toBe('npx')
    expect(merged.args).toEqual(['-y', 'server-github'])
    expect(merged.env).toEqual({ A: 'secret://keychain/hu-agent/a', B: 'secret://keychain/hu-agent/b' })
    expect(merged.enabled).toEqual({ global: true, workspaces: ['ws_a', 'ws_b'] })
    expect(merged.approval).toBe('ask')
  })

  it('catalog 标记来源作用域', () => {
    const catalog = mergeCatalog({ a: { command: 'x' }, b: { command: 'y' } }, { b: { enabled: { workspaces: ['w'] } } })
    expect(catalog.map((entry) => `${entry.name}:${entry.scope}`)).toEqual(['a:global', 'b:both'])
  })

  it('生效条件：全局启用或工作空间在列表中', () => {
    expect(isEnabledFor({ enabled: { global: true } }, 'w1')).toBe(true)
    expect(isEnabledFor({ enabled: { workspaces: ['w1'] } }, 'w1')).toBe(true)
    expect(isEnabledFor({ enabled: { workspaces: ['w2'] } }, 'w1')).toBe(false)
    expect(isEnabledFor({}, 'w1')).toBe(false)
  })

  it('保存与删除 server 条目，保留同文件其他条目', async () => {
    const file = join(dir, 'mcp.json')
    await saveMcpServer(file, 'github', { command: 'npx', args: ['-y', 'srv'], enabled: { global: true } })
    await saveMcpServer(file, 'other', { command: 'uvx', enabled: { global: false } })
    let parsed = JSON.parse(await readFile(file, 'utf8')) as { servers: Record<string, McpServerConfig> }
    expect(Object.keys(parsed.servers).sort()).toEqual(['github', 'other'])
    expect(parsed.servers.github).toEqual({ command: 'npx', args: ['-y', 'srv'], enabled: { global: true } })

    await saveMcpServer(file, 'github', null)
    parsed = JSON.parse(await readFile(file, 'utf8')) as { servers: Record<string, McpServerConfig> }
    expect(parsed.servers.github).toBeUndefined()
    expect(parsed.servers.other?.command).toBe('uvx')
  })

  it('工作空间只写 enabled 覆盖记录，读取时仍然拿到全局 command', () => {
    const global = { github: { command: 'npx', args: ['-y', 'srv'], enabled: { global: false } } }
    const workspace = { github: { enabled: { global: false, workspaces: ['ws_1'] } } }
    const [entry] = mergeCatalog(global, workspace)
    expect(entry?.config.command).toBe('npx')
    expect(isEnabledFor(entry!.config, 'ws_1')).toBe(true)
  })

  it('明文密钥写入密钥库并替换为 secret:// 引用；已有引用原样保留', async () => {
    const secrets = new FakeSecrets()
    const stored = await materializeSecrets(
      'github',
      { TOKEN: 'plain-123', EXISTING: 'secret://keychain/hu-agent/other' },
      secrets,
    )
    expect(stored).toEqual({
      TOKEN: 'secret://keychain/hu-agent/mcp/github/TOKEN',
      EXISTING: 'secret://keychain/hu-agent/other',
    })
    expect(secrets.get('hu-agent/mcp/github/TOKEN')).toBe('plain-123')
    expect(resolveSecretValue('secret://keychain/hu-agent/mcp/github/TOKEN', secrets)).toBe('plain-123')
    expect(resolveSecretValue('hu-agent/mcp/github/TOKEN', secrets)).toBe('plain-123')
    expect(resolveSecretValue('keychain/hu-agent/other', secrets)).toBeNull()
  })
})
