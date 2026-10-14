/**
 * 渲染层 i18n：模块级当前语言 + 订阅（locale 变更时由根组件触发整树重渲染）。
 *
 * 之所以不用「每个组件一个 hook」：文案量大（数百条），逐组件订阅噪音大；
 * 这里只让根组件（App）与语言切换器订阅，其余组件直接调用模块级 `t()`，
 * 语言切换时根组件重渲染即可带动整树。
 */

import { useSyncExternalStore } from 'react'

import { DEFAULT_LOCALE, lookup, type Locale, type LocalePreference, type MessageParams } from '@shared/i18n'

let currentLocale: Locale = DEFAULT_LOCALE
let currentPreference: LocalePreference = 'system'
const listeners = new Set<() => void>()

export function getLocale(): Locale {
  return currentLocale
}

export function getPreference(): LocalePreference {
  return currentPreference
}

/** 取词（模块级，供任意模块/工具函数使用） */
export function t(key: string, params?: MessageParams): string {
  return lookup(currentLocale, key, params)
}

function notify(): void {
  document.documentElement.lang = currentLocale
  for (const listener of listeners) listener()
}

/** 应用主进程解析好的语言（启动与切换语言时调用） */
export function applyResolved(preference: LocalePreference, resolved: Locale): Locale {
  currentPreference = preference
  currentLocale = resolved
  notify()
  return currentLocale
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 订阅当前语言：根组件与语言切换器使用 */
export function useI18n(): { locale: Locale; preference: LocalePreference; t: typeof t } {
  const locale = useSyncExternalStore(subscribe, getLocale)
  const preference = useSyncExternalStore(subscribe, getPreference)
  return { locale, preference, t }
}
