/** MCP 配置（design 5.8.1）：全局 ~/.hu-agent/mcp.json + 工作空间 <ws>/.hu/mcp.json。
 *
 * 工作空间同名 server 按字段覆盖全局（只写 enabled 字段即可单独启停）；
 * 密钥永不落配置文件，env/headers 里只保留 secret:// 引用。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { globalDir } from '../config/paths'
import type { WorkspacePaths } from '../workspace'

export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpApproval = 'ask' | 'session' | 'always'

export interface McpServerConfig {
  transport?: McpTransport
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: { global?: boolean; workspaces?: string[] }
  approval?: McpApproval
  source?: { type: string; mcpId?: string; version?: number }
}

export interface McpFile {
  servers?: Record<string, McpServerConfig>
}

export interface McpCatalogEntry {
  name: string
  config: McpServerConfig
  scope: 'global' | 'workspace' | 'both'
}

export function globalMcpFile(): string {
  return join(globalDir(), 'mcp.json')
}

export function workspaceMcpFile(ws: WorkspacePaths): string {
  return join(ws.huDir, 'mcp.json')
}

export async function loadMcpFile(file: string): Promise<Record<string, McpServerConfig>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as McpFile
    return parsed.servers ?? {}
  } catch {
    return {}
  }
}

/** 按字段合并全局与工作空间配置，enabled.workspaces 取并集。 */
export function mergeCatalog(
  globalServers: Record<string, McpServerConfig>,
  workspaceServers: Record<string, McpServerConfig>,
): McpCatalogEntry[] {
  const names = [...new Set([...Object.keys(globalServers), ...Object.keys(workspaceServers)])].sort()
  return names.map((name) => {
    const base = globalServers[name]
    const override = workspaceServers[name]
    const scope: McpCatalogEntry['scope'] = base && override ? 'both' : override ? 'workspace' : 'global'
    return { name, config: mergeConfig(base, override), scope }
  })
}

export function mergeConfig(
  base: McpServerConfig | undefined,
  override: McpServerConfig | undefined,
): McpServerConfig {
  return {
    transport: override?.transport ?? base?.transport ?? 'stdio',
    command: override?.command ?? base?.command,
    args: override?.args ?? base?.args,
    env: { ...(base?.env ?? {}), ...(override?.env ?? {}) },
    url: override?.url ?? base?.url,
    headers: { ...(base?.headers ?? {}), ...(override?.headers ?? {}) },
    approval: override?.approval ?? base?.approval,
    source: override?.source ?? base?.source,
    enabled: {
      global: override?.enabled?.global ?? base?.enabled?.global ?? false,
      workspaces: [...new Set([...(base?.enabled?.workspaces ?? []), ...(override?.enabled?.workspaces ?? [])])],
    },
  }
}

/** 生效条件：全局启用，或在 enabled.workspaces 里包含当前工作空间。 */
export function isEnabledFor(config: McpServerConfig, workspaceId: string): boolean {
  return Boolean(config.enabled?.global) || (config.enabled?.workspaces ?? []).includes(workspaceId)
}

export function formatMcpSummary(config: McpServerConfig): string {
  if ((config.transport ?? 'stdio') === 'stdio') {
    return [config.command ?? '', ...(config.args ?? [])].join(' ').trim()
  }
  return config.url ?? ''
}

/** 读取/写入单个作用域文件的 server 条目（写入为原子替换，保留其他条目）。 */
export async function saveMcpServer(
  file: string,
  name: string,
  config: McpServerConfig | null,
): Promise<void> {
  const servers = await loadMcpFile(file)
  if (config === null) delete servers[name]
  else servers[name] = config
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify({ servers } satisfies McpFile, null, 2), 'utf8')
  await rename(temp, file)
}

const SECRET_PREFIX = 'secret://keychain/'

/** 只依赖最小接口，便于单测替换（SecretStore 天然满足）。 */
export interface SecretReader {
  get(key: string): string | null
}

export interface SecretWriter {
  set(key: string, value: string): Promise<void>
}

/** 把值解析成真实密钥：`secret://keychain/<service>/<account>` → 密钥库键 `<service>/<account>`。 */
export function resolveSecretValue(value: string, secrets: SecretReader): string | null {
  const key = value.startsWith(SECRET_PREFIX) ? value.slice(SECRET_PREFIX.length) : value
  return secrets.get(key)
}

export function isSecretRef(value: string): boolean {
  return value.startsWith(SECRET_PREFIX)
}

/** 明文值写入密钥库并替换为 secret:// 引用；已是引用则原样保留。 */
export async function materializeSecrets(
  server: string,
  values: Record<string, string> | undefined,
  secrets: SecretReader & SecretWriter,
): Promise<Record<string, string> | undefined> {
  if (!values) return undefined
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (isSecretRef(value)) {
      result[key] = value
      continue
    }
    const storeKey = `hu-agent/mcp/${server}/${key}`
    await secrets.set(storeKey, value)
    result[key] = `${SECRET_PREFIX}${storeKey}`
  }
  return result
}
