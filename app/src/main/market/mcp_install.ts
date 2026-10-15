/**
 * 市场 MCP 安装装配（design 6.5 / 5.8.3）：把服务端的连接描述落成本地 mcp.json 条目。
 *
 * - 配置模板原样投影（stdio → command/args；http/sse → url）；
 * - `env_schema` 中 `secret: true` 的值写入本机密钥库，配置里只留 `secret://keychain/...` 引用；
 *   非密钥值直接落配置（stdio → env，http/sse → headers）。服务端永远拿不到值；
 * - `source` 记录市场来源（mcpId + 版本），供状态检查、激活上报与更新判断使用。
 */

import { t } from '../i18n'
import { sanitizeName, type McpServerConfig, type SecretWriter } from '../mcp/config'
import type { MarketMcpEnvField, McpTransportKind } from './client'

export interface BuildMarketMcpConfigOptions {
  id: string
  name: string
  transport: McpTransportKind
  configTemplate: Record<string, unknown>
  envSchema: MarketMcpEnvField[]
  version: number
  values: Record<string, string>
  secrets: SecretWriter
}

export async function buildMarketMcpConfig(options: BuildMarketMcpConfigOptions): Promise<McpServerConfig> {
  const { id, name, transport, configTemplate, envSchema, values, secrets } = options
  const config: McpServerConfig = {
    transport,
    enabled: { global: true, workspaces: [] },
    approval: 'ask',
    source: { type: 'market', mcpId: id, version: options.version },
  }

  if (transport === 'stdio') {
    const command = typeof configTemplate.command === 'string' ? configTemplate.command.trim() : ''
    if (!command) throw new Error(t('MCP 配置模板缺少 command'))
    config.command = command
    if (Array.isArray(configTemplate.args)) config.args = configTemplate.args.map((arg) => String(arg))
  } else {
    const url = typeof configTemplate.url === 'string' ? configTemplate.url.trim() : ''
    if (!url) throw new Error(t('MCP 配置模板缺少 url'))
    config.url = url
  }

  // stdio 的凭据走 env；http/sse 走 headers
  const target: Record<string, string> = {}
  for (const field of envSchema) {
    const value = values[field.key]?.trim()
    if (!value) {
      if (field.required) throw new Error(t('缺少必填的环境变量：{key}', { key: field.key }))
      continue
    }
    if (field.secret) {
      const storeKey = `hu-agent/mcp/${sanitizeName(name)}/${field.key}`
      await secrets.set(storeKey, value)
      target[field.key] = `secret://keychain/${storeKey}`
    } else {
      target[field.key] = value
    }
  }
  if (Object.keys(target).length > 0) {
    if (transport === 'stdio') config.env = target
    else config.headers = target
  }
  return config
}
