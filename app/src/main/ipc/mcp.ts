/** MCP 本地配置域 IPC：列表/保存/删除/启停/测试（design 5.8.1）。 */

import { ipcMain } from 'electron'

import { t } from '../i18n'
import {
  globalMcpFile,
  loadMcpFile,
  materializeSecrets,
  saveMcpServer,
  workspaceMcpFile,
  type McpServerConfig,
} from '../mcp/config'
import { scoped, type AppContext } from './context'

interface McpSaveInputWire {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  approval?: 'ask' | 'session' | 'always'
  scope: 'global' | 'workspace'
}

export function registerMcpIpc(context: AppContext): void {
  ipcMain.handle('mcp:list', async () => {
    const { ws } = await scoped(context)
    return context.mcp.list(ws)
  })
  ipcMain.handle('mcp:save', async (_event, input: McpSaveInputWire) => {
    const { ws } = await scoped(context)
    const name = input.name.trim()
    if (!name) throw new Error(t('请填写 server 名称'))
    if (input.transport === 'stdio' && !input.command?.trim()) throw new Error(t('stdio 传输需要填写 command'))
    if (input.transport !== 'stdio' && !input.url?.trim()) {
      throw new Error(t('{transport} 传输需要填写 URL', { transport: input.transport }))
    }
    const file = input.scope === 'global' ? globalMcpFile() : workspaceMcpFile(ws)
    const existing = (await loadMcpFile(file))[name]
    const config: McpServerConfig = {
      transport: input.transport,
      command: input.command?.trim() || undefined,
      args: (input.args ?? []).filter((arg) => arg.length > 0),
      env: await materializeSecrets(name, input.env, context.secrets),
      headers: await materializeSecrets(name, input.headers, context.secrets),
      url: input.url?.trim() || undefined,
      approval: input.approval ?? 'ask',
      enabled:
        input.scope === 'global'
          ? { global: existing?.enabled?.global ?? true, workspaces: existing?.enabled?.workspaces ?? [] }
          : {
              global: existing?.enabled?.global,
              workspaces: [...new Set([...(existing?.enabled?.workspaces ?? []), ws.id])],
            },
    }
    await saveMcpServer(file, name, config)
    await context.mcp.reload(ws)
    return context.mcp.list(ws)
  })
  ipcMain.handle('mcp:remove', async (_event, name: string, scope: 'global' | 'workspace') => {
    const { ws } = await scoped(context)
    await saveMcpServer(scope === 'global' ? globalMcpFile() : workspaceMcpFile(ws), name, null)
    await context.mcp.reload(ws)
    return context.mcp.list(ws)
  })
  ipcMain.handle(
    'mcp:set-enabled',
    async (_event, name: string, scope: 'global' | 'workspace', enabled: boolean) => {
      const { ws } = await scoped(context)
      const file = scope === 'global' ? globalMcpFile() : workspaceMcpFile(ws)
      const current = (await loadMcpFile(file))[name]
      if (!current && scope === 'global') throw new Error(t('该 server 未在全局定义，无法全局启停'))
      const next: McpServerConfig = {
        ...(current ?? {}),
        enabled: {
          global: scope === 'global' ? enabled : current?.enabled?.global,
          workspaces:
            scope === 'workspace'
              ? enabled
                ? [...new Set([...(current?.enabled?.workspaces ?? []), ws.id])]
                : (current?.enabled?.workspaces ?? []).filter((id) => id !== ws.id)
              : (current?.enabled?.workspaces ?? []),
        },
      }
      await saveMcpServer(file, name, next)
      await context.mcp.reload(ws)
      return context.mcp.list(ws)
    },
  )
  ipcMain.handle('mcp:test', async (_event, name: string) => {
    const { ws } = await scoped(context)
    return context.mcp.test(ws, name)
  })
}
