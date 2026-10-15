/** 设置域 IPC：应用版本、模型 provider 设置与语言（design 5.9 / 5.13）。 */

import { app, ipcMain } from 'electron'

import type { LocaleView } from '../../shared/ipc'
import type { LocalePreference } from '../../shared/i18n'
import { getLocale, getLocalePreference, setLocale, systemLocale, t } from '../i18n'
import type { ModelSettings } from '../model/types'
import type { AppContext } from './context'

interface SaveProviderInputWire {
  id: string
  apiType: ModelSettings['providers'][number]['apiType']
  baseUrl: string
  apiKey?: string | null
  models: ModelSettings['providers'][number]['models']
}

export function registerSettingsIpc(context: AppContext): void {
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('settings:get', () => buildSettingsView(context))
  ipcMain.handle('settings:get-locale', () => localeView())
  ipcMain.handle('settings:set-locale', async (_event, preference: LocalePreference) => {
    const resolved = await setLocale(preference)
    console.log(t('语言已切换为 {0}', { 0: resolved }))
    return localeView()
  })
  ipcMain.handle('settings:save-provider', async (_event, input: SaveProviderInputWire) => {
    const settings = await context.settings.load()
    // 模型密钥统一存 `model:<providerId>`：这是 pi 运行时读取的引用名（ADR-0006 决策 8）
    const secretKey = `model:${input.id}`
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
    await context.runtime.refresh()
    return buildSettingsView(context)
  })
  ipcMain.handle('settings:remove-provider', async (_event, providerId: string) => {
    const settings = await context.settings.load()
    const providers = settings.providers.filter((provider) => provider.id !== providerId)
    await context.settings.save({ ...settings, providers })
    await context.runtime.refresh()
    return buildSettingsView(context)
  })
  ipcMain.handle('settings:set-default', async (_event, role: 'primary' | 'fast', target: string) => {
    const settings = await context.settings.load()
    const next: ModelSettings = { ...settings, defaults: { ...settings.defaults, [role]: target } }
    await context.settings.save(next)
    return buildSettingsView(context)
  })
}

/** 语言视图：偏好 + 生效值 + 操作系统解析值（design 5.13） */
function localeView(): LocaleView {
  return { preference: getLocalePreference(), resolved: getLocale(), system: systemLocale() }
}

async function buildSettingsView(context: AppContext): Promise<import('../../shared/ipc').SettingsView> {
  const settings = await context.settings.load()
  const secretsConfigured: Record<string, boolean> = {}
  const availableModels: import('../../shared/ipc').ModelOptionView[] = []
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
