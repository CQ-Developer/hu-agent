/**
 * 主进程 IPC 注册入口（design 5.1/5.5/5.6）。
 *
 * 各域处理器在 `ipc/` 目录内按域拆分（设置、会话、工作空间、Skill、市场、MCP、同步、
 * 统计、权限、云账户）；本文件只做组合与对外导出，channel 名单与 `shared/ipc.ts` 契约一致。
 */

import { registerCloudIpc } from './ipc/cloud'
import type { AppContext } from './ipc/context'
import { registerMarketIpc } from './ipc/market'
import { registerMcpIpc } from './ipc/mcp'
import { registerPermissionsIpc } from './ipc/permissions'
import { registerSessionsIpc } from './ipc/sessions'
import { registerSettingsIpc } from './ipc/settings'
import { registerSkillsIpc } from './ipc/skills'
import { registerStatsIpc } from './ipc/stats'
import { registerSyncIpc } from './ipc/sync'
import { registerWorkspaceIpc } from './ipc/workspace'

export type { AppContext } from './ipc/context'
export { broadcastEvent, broadcastInteraction, broadcastSessionLost, broadcastSyncEvent } from './ipc/broadcast'

export function registerIpc(context: AppContext): void {
  registerSettingsIpc(context)
  registerSessionsIpc(context)
  registerWorkspaceIpc(context)
  registerSkillsIpc(context)
  registerMarketIpc(context)
  registerMcpIpc(context)
  registerSyncIpc(context)
  registerStatsIpc(context)
  registerPermissionsIpc(context)
  registerCloudIpc(context)
}
