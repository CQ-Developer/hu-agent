/**
 * 管理台主题偏好（液态玻璃，2026-10-15）：
 * `system`（默认，跟随系统） / `light` / `dark`，存 localStorage；在 <html> 上切换 `.dark`/`.light`。
 */

import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'huagent.management.theme'
const listeners = new Set<() => void>()

function readPreference(): ThemePreference {
  const value = localStorage.getItem(STORAGE_KEY)
  return value === 'light' || value === 'dark' ? value : 'system'
}

let preference: ThemePreference = readPreference()

function systemTheme(): ResolvedTheme {
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function resolveTheme(value: ThemePreference = preference): ResolvedTheme {
  return value === 'system' ? systemTheme() : value
}

function apply(): void {
  const root = document.documentElement
  const resolved = resolveTheme()
  root.classList.toggle('dark', resolved === 'dark')
  root.classList.toggle('light', resolved === 'light')
  root.dataset.theme = resolved
}

export function setThemePreference(next: ThemePreference): void {
  preference = next
  localStorage.setItem(STORAGE_KEY, next)
  apply()
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  apply()
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (preference === 'system') {
      apply()
      for (const listener of listeners) listener()
    }
  })
}

export function useTheme(): {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (value: ThemePreference) => void
} {
  const current = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => preference,
  )
  return { preference: current, resolved: resolveTheme(current), setPreference: setThemePreference }
}
