/** 主进程 → 渲染进程的事件广播（design 5.1/5.11.5；所有窗口统一出口）。 */

import { BrowserWindow } from 'electron'

import type { AgentEvent, ApprovalRequestView, GuideRequestView } from '../../shared/events'
import type { SyncStatusView } from '../../shared/ipc'

export function broadcastEvent(event: AgentEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('agent:event', event)
  }
}

/** 定时同步结果推送给渲染进程（design 5.11.5）。 */
export function broadcastSyncEvent(view: SyncStatusView): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('sync:event', view)
  }
}

/** 会话被服务端拒绝（ADR 0004）：通知所有窗口退回登录门禁。 */
export function broadcastSessionLost(reason: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('cloud:session-lost', reason)
  }
}

/** 把交互桥的请求包装成统一的 AgentEvent 通道。 */
export function broadcastInteraction(view: ApprovalRequestView | GuideRequestView): void {
  if ('toolName' in view) {
    broadcastEvent({
      type: 'tool.approval_required',
      sessionId: view.sessionId,
      turnId: view.turnId,
      request: view,
    })
  } else {
    broadcastEvent({ type: 'ask_guide', sessionId: view.sessionId, turnId: view.turnId, request: view })
  }
}
