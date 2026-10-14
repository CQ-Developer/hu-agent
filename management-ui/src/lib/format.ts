/**
 * 展示格式化（design 7.1：日期、数字、时区统一格式化）。
 */

export function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(date)
}

export function formatDate(value: string | null | undefined, locale: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}

export function formatNumber(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '-'
  return new Intl.NumberFormat(locale).format(value)
}

export function formatBytes(value: number | null | undefined): string {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}

/** 本地时区日期（YYYY-MM-DD），用于统计筛选默认值 */
export function todayISO(): string {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

export function daysAgoISO(days: number): string {
  const date = new Date(Date.now() - days * 86_400_000)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}
