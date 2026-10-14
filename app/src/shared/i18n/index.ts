/**
 * 国际化内核（design 5.13 / D13）。
 *
 * 设计取舍：**中文原文即消息键**（gettext 的 msgid 模型）。
 * - zh-CN 无需词典：直接用键本身（插值后返回），新增文案立即生效不会漏翻；
 * - en-US 只需维护「中文 → 英文」一张表，遗漏由 `app/tests/i18n.test.ts` 强制拦截；
 * - 主进程与渲染层共用同一份词典，避免两处重复。
 */

import enUS from './en-US'

export type Locale = 'zh-CN' | 'en-US'
/** 语言偏好：`system` 表示跟随操作系统 */
export type LocalePreference = Locale | 'system'

export const LOCALES: Locale[] = ['zh-CN', 'en-US']
export const DEFAULT_LOCALE: Locale = 'zh-CN'

/** 位置参数：`{0}`；具名参数：`{count}`（undefined/null 渲染为空串） */
export type MessageParam = string | number | boolean | null | undefined
export type MessageParams = Record<string, MessageParam>

/**
 * 英文复数：值为二元组时按 count 选 [单数, 复数]（仅 en-US 使用）。
 */
export type Message = string | [string, string]

const dictionaries: Record<Locale, Record<string, Message>> = {
  'zh-CN': {}, // 中文即键，无需词典
  'en-US': enUS,
}

/** 把 `zh-CN`、`zh-Hans-CN`、`en-GB` 等归一为受支持的语言；无法判断时返回 fallback */
export function normalizeLocale(value: string | null | undefined, fallback: Locale = DEFAULT_LOCALE): Locale {
  if (!value) return fallback
  const lowered = value.toLowerCase()
  if (lowered.startsWith('zh')) return 'zh-CN'
  if (lowered.startsWith('en')) return 'en-US'
  return fallback
}

export function resolveLocale(preference: LocalePreference | null | undefined, systemLocale: string): Locale {
  if (preference === 'zh-CN' || preference === 'en-US') return preference
  return normalizeLocale(systemLocale)
}

/** 插值：`{name}` 与 `{0}`；未知占位符原样保留（便于暴露遗漏） */
export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(params, key) ? String(params[key] ?? '') : match,
  )
}

function pickMessage(value: Message, locale: Locale, params?: MessageParams): string {
  if (Array.isArray(value)) {
    if (locale === 'zh-CN') return value[0]
    const count = Number(params?.count ?? 0)
    return count === 1 ? value[0] : value[1]
  }
  return value
}

/** 取词：zh-CN 用键本身；en-US 查词典，缺失时回退中文并保持可读 */
export function lookup(locale: Locale, key: string, params?: MessageParams): string {
  const value = dictionaries[locale]?.[key]
  const template = value === undefined ? key : pickMessage(value, locale, params)
  return interpolate(template, params)
}

export function translate(locale: Locale, key: string, params?: MessageParams): string {
  return lookup(locale, key, params)
}

/** 便于测试与漏翻检查：某语言词典的全部键 */
export function dictionaryKeys(locale: Locale): string[] {
  return Object.keys(dictionaries[locale] ?? {})
}

export type Translate = (key: string, params?: MessageParams) => string
