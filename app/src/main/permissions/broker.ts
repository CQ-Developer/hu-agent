/** 主进程 -> UI 的交互桥：授权卡片与 ask_guide（design 5.2.1/5.4.3）。 */

import { randomUUID } from 'node:crypto'

import type { ApprovalRequestView, GuideRequestView } from '../../shared/events'
import type { ApprovalChoice } from './types'

export interface InteractionBrokerDeps {
  broadcast: (event: ApprovalRequestView | GuideRequestView) => void
}

interface Pending<T> {
  sessionId: string
  resolve: (value: T) => void
}

export class InteractionBroker {
  private readonly approvals = new Map<string, Pending<ApprovalChoice>>()
  private readonly guides = new Map<string, Pending<string>>()

  constructor(private readonly deps: InteractionBrokerDeps) {}

  requestApproval(request: Omit<ApprovalRequestView, 'id'>): Promise<ApprovalChoice> {
    const id = randomUUID()
    return new Promise<ApprovalChoice>((resolve) => {
      this.approvals.set(id, { sessionId: request.sessionId, resolve })
      this.deps.broadcast({ ...request, id })
    })
  }

  resolveApproval(id: string, choice: ApprovalChoice): void {
    const pending = this.approvals.get(id)
    if (!pending) return
    this.approvals.delete(id)
    pending.resolve(choice)
  }

  askGuide(request: Omit<GuideRequestView, 'id'>): Promise<string> {
    const id = randomUUID()
    return new Promise<string>((resolve) => {
      this.guides.set(id, { sessionId: request.sessionId, resolve })
      this.deps.broadcast({ ...request, id })
    })
  }

  answerGuide(id: string, value: string): void {
    const pending = this.guides.get(id)
    if (!pending) return
    this.guides.delete(id)
    pending.resolve(value)
  }

  /** 取消某会话的未决交互（拒绝授权 / 空回答）。 */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.approvals) {
      if (pending.sessionId === sessionId) {
        this.approvals.delete(id)
        pending.resolve('deny')
      }
    }
    for (const [id, pending] of this.guides) {
      if (pending.sessionId === sessionId) {
        this.guides.delete(id)
        pending.resolve('')
      }
    }
  }
}
