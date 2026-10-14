/**
 * 主进程 i18n：当前语言状态 + `t()`。
 *
 * 语言偏好存放在 `~/.hu-agent/config.json` 的 `ui.locale`（`system` 表示跟随操作系统），
 * 与模型配置共用同一文件；启动时由 index.ts 调用 `initI18n()` 完成初始化，
 * 之后主进程产生的一切**用户可见**文案（错误、通知、对话框）都应通过 `t()` 取词。
 */

import { app } from 'electron'

import { lookup, resolveLocale, type Locale, type LocalePreference, type MessageParams } from '../shared/i18n'
import { PreferencesStore } from './config/preferences'

let currentLocale: Locale = 'zh-CN'
let currentPreference: LocalePreference = 'system'
let store: PreferencesStore | null = null

/** 启动时初始化（须在创建窗口/IPC 之前调用） */
export async function initI18n(configFile: string): Promise<Locale> {
  store ??= new PreferencesStore(configFile)
  const preference = await store.getLocale()
  currentPreference = preference
  currentLocale = resolveLocale(preference, app.getLocale())
  return currentLocale
}

export function getLocale(): Locale {
  return currentLocale
}

export function getLocalePreference(): LocalePreference {
  return currentPreference
}

/** 取词；zh-CN 直接返回中文原文（键即文案） */
export function t(key: string, params?: MessageParams): string {
  return lookup(currentLocale, key, params)
}

/** 切换语言并持久化；返回生效后的语言 */
export async function setLocale(preference: LocalePreference): Promise<Locale> {
  store ??= new PreferencesStore('')
  await store.setLocale(preference)
  currentPreference = preference
  currentLocale = resolveLocale(preference, app.getLocale())
  return currentLocale
}

/** 系统语言解析结果（供设置页展示「跟随系统」实际生效值） */
export function systemLocale(): Locale {
  return resolveLocale('system', app.getLocale())
}
