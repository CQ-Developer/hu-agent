/** 主进程 IPC 注册（design 5.1：主进程承载 Agent Core，渲染进程只经白名单 IPC 访问）。 */

import { BrowserWindow, app, ipcMain } from 'electron'

import { ModelGateway } from './model/gateway'
import type { ModelSettings, ReasoningEffort } from './model/types'
import { runTurn } from './agent/loop'
import type { SecretStore } from './config/secrets'
import type { SettingsStore } from './config/settings-store'
import type { ArtifactStore } from './session/artifacts'
import type { SessionStore } from './session/store'
import { buildSessionItems } from './session/items'
import { computeSessionUsage } from './session/stats'
import type { SessionOptionsView } from '../shared/ipc'
import type { ToolRegistry } from './tools/registry'
import type { UsageLedger } from './usage/ledger'
import type { WorkspacePaths } from './workspace'
import type { AgentEvent } from '../shared/events'

export interface AppContext {
  workspace: WorkspacePaths
  sessions: SessionStore
  artifacts: ArtifactStore
  ledger: UsageLedger
  settings: SettingsStore
  secrets: SecretStore
  gateway: ModelGateway
  tools: ToolRegistry
}

export function registerIpc(context: AppContext): void {
  const activeTurns = new Map<string, AbortController>()

  const broadcast = (event: AgentEvent): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('agent:event', event)
    }
  }

  ipcMain.handle('app:get-version', () => app.getVersion())

  ipcMain.handle('settings:get', () => buildSettingsView(context))
  ipcMain.handle('settings:save-provider', async (_event, input: SaveProviderInputWire) => {
    const settings = await context.settings.load()
    const secretKey = input.apiKeyRef ?? `provider.${input.id}`
    if (typeof input.apiKey === 'string') {
      if (input.apiKey.length === 0) await context.secrets.delete(secretKey)
      else await context.secrets.set(secretKey, input.apiKey)
    }
    const providers = settings.providers.filter((provider) => provider.id !== input.id)
    providers.push({
      id: input.id,
      apiType: input.apiType,
      baseUrl: input.baseUrl,
      apiKeyRef: context.secrets.has(secretKey) ? secretKey : null,
      models: input.models,
    })
    const defaults = { ...settings.defaults }
    if (!providers.some((provider) => provider.id === defaults.primary.split('/')[0])) {
      defaults.primary = `${providers[0]?.id ?? ''}/${providers[0]?.models[0]?.name ?? ''}`
    }
    await context.settings.save({ providers, defaults })
    return buildSettingsView(context)
  })
  ipcMain.handle('settings:remove-provider', async (_event, providerId: string) => {
    const settings = await context.settings.load()
    const providers = settings.providers.filter((provider) => provider.id !== providerId)
    await context.settings.save({ ...settings, providers })
    return buildSettingsView(context)
  })
  ipcMain.handle('settings:set-default', async (_event, role: 'primary' | 'fast', target: string) => {
    const settings = await context.settings.load()
    const next: ModelSettings = { ...settings, defaults: { ...settings.defaults, [role]: target } }
    await context.settings.save(next)
    return buildSettingsView(context)
  })

  ipcMain.handle('sessions:list', () => context.sessions.list())
  ipcMain.handle('sessions:create', () => context.sessions.create())
  ipcMain.handle('sessions:items', async (_event, sessionId: string) =>
    buildSessionItems(await context.sessions.readLines(sessionId).then((result) => result.lines)),
  )
  ipcMain.handle('sessions:rename', (_event, sessionId: string, title: string) =>
    context.sessions.rename(sessionId, title),
  )
  ipcMain.handle('sessions:options', (_event, sessionId: string) => resolveSessionOptions(context, sessionId))
  ipcMain.handle('sessions:set-options', async (_event, sessionId: string, options: SessionOptionsView) => {
    await context.sessions.setOptions(sessionId, {
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    })
    return resolveSessionOptions(context, sessionId)
  })
  ipcMain.handle('sessions:stats', async (_event, sessionId: string) => {
    const { lines } = await context.sessions.readLines(sessionId)
    const options = await resolveSessionOptions(context, sessionId)
    const { model } = context.gateway.resolve(options.model)
    return computeSessionUsage(lines, model.capabilities.contextWindow)
  })

  ipcMain.handle('agent:send', async (_event, sessionId: string, text: string) => {
    if (activeTurns.has(sessionId)) throw new Error('该会话已有运行中的任务')
    const controller = new AbortController()
    activeTurns.set(sessionId, controller)
    try {
      await runTurn(
        {
          gateway: context.gateway,
          tools: context.tools,
          sessions: context.sessions,
          artifacts: context.artifacts,
          ledger: context.ledger,
          emit: broadcast,
          workspaceRoot: context.workspace.root,
        },
        { sessionId, userText: text, signal: controller.signal },
      )
    } finally {
      activeTurns.delete(sessionId)
    }
  })
  ipcMain.handle('agent:cancel', (_event, sessionId: string) => {
    activeTurns.get(sessionId)?.abort()
  })

  ipcMain.handle('usage:stats', () => context.ledger.stats())
  ipcMain.handle('workspace:info', () => ({ id: context.workspace.id, root: context.workspace.root }))
}

interface SaveProviderInputWire {
  id: string
  apiType: ModelSettings['providers'][number]['apiType']
  baseUrl: string
  apiKey?: string | null
  apiKeyRef?: string | null
  models: ModelSettings['providers'][number]['models']
}

async function resolveSessionOptions(context: AppContext, sessionId: string): Promise<SessionOptionsView> {
  const settings = await context.settings.load()
  const stored = await context.sessions.loadOptions(sessionId)
  return {
    model: stored.model ?? settings.defaults.primary,
    reasoningEffort: (stored.reasoningEffort ?? 'off') as ReasoningEffort,
  }
}

async function buildSettingsView(context: AppContext): Promise<import('../shared/ipc').SettingsView> {
  const settings = await context.settings.load()
  const secretsConfigured: Record<string, boolean> = {}
  const availableModels: import('../shared/ipc').ModelOptionView[] = []
  for (const provider of settings.providers) {
    if (provider.apiKeyRef) secretsConfigured[provider.apiKeyRef] = context.secrets.has(provider.apiKeyRef)
    for (const model of provider.models) {
      availableModels.push({
        target: `${provider.id}/${model.name}`,
        providerId: provider.id,
        name: model.name,
        contextWindow: model.capabilities.contextWindow,
        reasoningEffort: model.capabilities.reasoningEffort ?? false,
      })
    }
  }
  return {
    providers: settings.providers.map((provider) => ({ ...provider, apiKeyRef: provider.apiKeyRef ?? null })),
    defaults: settings.defaults,
    secretsConfigured,
    availableModels,
  }
}
