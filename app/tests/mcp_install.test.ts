/**
 * 市场 MCP 安装装配测试（design 6.5）：config_template → 本地 mcp.json 条目；
 * secret 字段只落密钥库（配置里留 secret:// 引用），非密钥值明文落配置。
 */

import { describe, expect, it } from 'vitest'

import { buildMarketMcpConfig } from '../src/main/market/mcp_install'

class MemorySecrets {
  values = new Map<string, string>()

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

const base = { id: 'server-1', name: 'github', version: 3 }

describe('buildMarketMcpConfig', () => {
  it('stdio：模板投影 + 密钥进密钥库、非密钥明文入 env、source 记录来源', async () => {
    const secrets = new MemorySecrets()
    const config = await buildMarketMcpConfig({
      ...base,
      transport: 'stdio',
      configTemplate: { command: 'npx', args: ['-y', 'server-github'] },
      envSchema: [
        { key: 'GITHUB_TOKEN', label: 'Token', secret: true, required: true, help: null },
        { key: 'GITHUB_HOST', label: 'Host', secret: false, required: false, help: null },
      ],
      values: { GITHUB_TOKEN: 'ghp_x', GITHUB_HOST: 'github.example.com' },
      secrets,
    })

    expect(config).toMatchObject({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'server-github'],
      enabled: { global: true, workspaces: [] },
      approval: 'ask',
      source: { type: 'market', mcpId: 'server-1', version: 3 },
    })
    expect(config.env).toMatchObject({
      GITHUB_TOKEN: 'secret://keychain/hu-agent/mcp/github/GITHUB_TOKEN',
      GITHUB_HOST: 'github.example.com',
    })
    expect(secrets.values.get('hu-agent/mcp/github/GITHUB_TOKEN')).toBe('ghp_x')
  })

  it('http：模板走 url，env_schema 落 headers（密钥同样只留引用）', async () => {
    const secrets = new MemorySecrets()
    const config = await buildMarketMcpConfig({
      ...base,
      transport: 'http',
      configTemplate: { url: 'https://mcp.example.com/v1' },
      envSchema: [{ key: 'AUTH', label: 'Auth', secret: true, required: true, help: null }],
      values: { AUTH: 'Bearer x' },
      secrets,
    })

    expect(config.url).toBe('https://mcp.example.com/v1')
    expect(config.env).toBeUndefined()
    expect(config.headers?.AUTH).toBe('secret://keychain/hu-agent/mcp/github/AUTH')
    expect(secrets.values.get('hu-agent/mcp/github/AUTH')).toBe('Bearer x')
  })

  it('必填缺失 / 模板缺字段：抛可读错误', async () => {
    const secrets = new MemorySecrets()
    await expect(
      buildMarketMcpConfig({
        ...base,
        transport: 'stdio',
        configTemplate: { command: 'npx' },
        envSchema: [{ key: 'TOKEN', label: 'Token', secret: true, required: true, help: null }],
        values: {},
        secrets,
      }),
    ).rejects.toThrow(/TOKEN/)

    await expect(
      buildMarketMcpConfig({
        ...base,
        transport: 'stdio',
        configTemplate: {},
        envSchema: [],
        values: {},
        secrets,
      }),
    ).rejects.toThrow(/command/)

    await expect(
      buildMarketMcpConfig({
        ...base,
        transport: 'http',
        configTemplate: {},
        envSchema: [],
        values: {},
        secrets,
      }),
    ).rejects.toThrow(/url/)
  })
})
