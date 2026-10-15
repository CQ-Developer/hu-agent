/** 会话域 IPC：会话列表/条目/选项/统计/搜索与回合控制（design 5.3 / 5.2）。 */

import { ipcMain } from 'electron'

import type { SessionOptionsView } from '../../shared/ipc'
import { t } from '../i18n'
import type { ModelSettings } from '../model/types'
import type { ApprovalChoice } from '../permissions/types'
import { type SessionView } from '../session/durable'
import {
  countAssistantEntries,
  fromSessionOptions,
  lastContextTokensOf,
  toSessionItems,
  toSessionMeta,
  toSessionOptions,
  toSessionUsage,
  type PiUsageLike,
} from '../session/durable_view'
import { broadcastEvent } from './broadcast'
import { buildEngine, scoped, type AppContext } from './context'

/** sessionId -> 运行中的回合（同一会话同一时刻只允许一个） */
const activeTurns = new Map<string, AbortController>()

export function registerSessionsIpc(context: AppContext): void {
  ipcMain.handle('sessions:list', async () => {
    const { sessions } = await scoped(context)
    return (await sessions.list()).map((entry) => toSessionMeta(entry, entry.messageCount))
  })
  ipcMain.handle('sessions:create', async () => {
    const { sessions } = await scoped(context)
    const settings = await context.settings.load()
    const entry = await sessions.create({ title: t('新会话'), model: defaultModelOf(settings) })
    return toSessionMeta(entry, entry.messageCount)
  })
  ipcMain.handle('sessions:items', async (_event, sessionId: string) => {
    const { sessions } = await scoped(context)
    return toSessionItems((await sessions.view(sessionId)).entries as never[])
  })
  ipcMain.handle('sessions:rename', async (_event, sessionId: string, title: string) => {
    const { sessions } = await scoped(context)
    await sessions.rename(sessionId, title)
  })
  ipcMain.handle('sessions:options', async (_event, sessionId: string) => {
    const { sessions } = await scoped(context)
    return toSessionOptions(await sessions.agentConfig(sessionId))
  })
  ipcMain.handle('sessions:set-options', async (_event, sessionId: string, options: SessionOptionsView) => {
    const { sessions } = await scoped(context)
    await sessions.configure(sessionId, fromSessionOptions(options))
    return toSessionOptions(await sessions.agentConfig(sessionId))
  })
  ipcMain.handle('sessions:stats', async (_event, sessionId: string) => {
    const { sessions } = await scoped(context)
    const view = await sessions.view(sessionId)
    const entries = (Array.isArray(view.entries) ? view.entries : []) as never[]
    const options = toSessionOptions(await sessions.agentConfig(sessionId))
    const settings = await context.settings.load()
    const lastContextTokens = lastContextTokensOf(entries)
    return toSessionUsage(sessionUsageDoc(view), {
      calls: countAssistantEntries(entries),
      contextWindow: contextWindowOf(settings, options.model),
      ...(lastContextTokens !== undefined ? { lastContextTokens } : {}),
    })
  })
  ipcMain.handle('sessions:search', async (_event, query: string) => (await scoped(context)).sessions.search(query))

  ipcMain.handle('agent:send', async (_event, sessionId: string, text: string) => {
    if (activeTurns.has(sessionId)) throw new Error(t('该会话已有运行中的任务'))
    const { ws, sessions, artifacts } = await scoped(context)
    const permissions = await buildEngine(context, ws)
    const controller = new AbortController()
    activeTurns.set(sessionId, controller)
    try {
      const runner = context.createRunner({
        workspaceRoot: ws.root,
        permissions,
        sessions,
        artifacts,
        skillSection: await context.skills.systemPromptSection(ws),
        extraTools: await context.mcp.tools(ws),
        telemetry: {
          record: async (input) => {
            try {
              await context.reporter.enqueue(ws, input)
              // 入队后后台尝试上报（未到退避时间会自动跳过）
              void context.reporter.tick([ws])
            } catch (error) {
              console.warn(t('[telemetry] 入队失败：'), error)
            }
          },
        },
      })

      await runner.runTurn({ sessionId, userText: text, signal: controller.signal, emit: broadcastEvent })
    } finally {
      activeTurns.delete(sessionId)
    }
  })
  ipcMain.handle('agent:cancel', (_event, sessionId: string) => {
    activeTurns.get(sessionId)?.abort()
    context.interactions.cancelSession(sessionId)
  })
  ipcMain.handle('agent:decide-approval', (_event, requestId: string, choice: ApprovalChoice) => {
    context.interactions.resolveApproval(requestId, choice)
  })
  ipcMain.handle('agent:answer-guide', (_event, requestId: string, value: string) => {
    context.interactions.answerGuide(requestId, value)
  })
}

/** 从模型设置里取目标模型的上下文窗口（stats 视图用；找不到就退回第一个可用模型） */
function contextWindowOf(settings: ModelSettings, target?: string): number {
  const slash = (target ?? '').indexOf('/')
  const providerId = slash >= 0 ? (target ?? '').slice(0, slash) : ''
  const modelName = slash >= 0 ? (target ?? '').slice(slash + 1) : (target ?? '')
  const provider =
    settings.providers.find((item) => item.id === providerId) ??
    settings.providers.find((item) => item.models.some((model) => model.name === modelName)) ??
    settings.providers[0]
  const model = provider?.models.find((item) => item.name === modelName) ?? provider?.models[0]
  return model?.capabilities.contextWindow ?? 0
}

/** 新建会话的默认模型：settings.defaults.primary 的 `provider/modelId` 形式 */
function defaultModelOf(settings: ModelSettings): { provider: string; modelId: string } | undefined {
  const slash = settings.defaults.primary.indexOf('/')
  if (slash <= 0) return undefined
  return {
    provider: settings.defaults.primary.slice(0, slash),
    modelId: settings.defaults.primary.slice(slash + 1),
  }
}

/**
 * 会话统计的用量来源是会话自己的 `pi.usage` 文档；
 * `DurableSessions.usage()`（harness.usage）是整库汇总，不能用于单会话。
 */
function sessionUsageDoc(view: SessionView): PiUsageLike {
  const usage = view.docs['pi.usage'] as PiUsageLike | undefined
  return usage ?? { models: {}, tools: {} }
}
