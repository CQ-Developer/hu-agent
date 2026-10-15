/**
 * 应用级偏好（`~/.hu-agent/config.json` 的 `ui` 段，design 5.9）。
 *
 * 与模型配置同文件，因此读写一律「读取 → 合并 → 原子写回」，避免互相覆盖。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { LocalePreference } from '../../shared/i18n'

export interface UIConfig {
  /** `system` 表示跟随操作系统语言 */
  locale: LocalePreference
}

/** 读取 config.json 原始内容（保留未知字段） */
export async function readRawConfig(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch {
    // 首次运行或文件损坏
  }
  return {}
}

/** 原子写回 config.json（先写临时文件再 rename） */
async function writeRawConfig(file: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await rename(temp, file)
}

export class PreferencesStore {
  private cache: Record<string, unknown> | null = null

  constructor(private readonly file: string) {}

  /** 读取 config.json（缓存），模型配置与 UI 偏好共享同一份缓存 */
  async raw(): Promise<Record<string, unknown>> {
    if (this.cache) return this.cache
    this.cache = await readRawConfig(this.file)
    return this.cache
  }

  async getUI(): Promise<UIConfig> {
    const raw = await this.raw()
    const ui = (raw.ui ?? {}) as Partial<UIConfig>
    return { locale: ui.locale ?? 'system' }
  }

  async getLocale(): Promise<LocalePreference> {
    return (await this.getUI()).locale
  }

  async setLocale(locale: LocalePreference): Promise<void> {
    const raw = await this.raw()
    const next = { ...raw, ui: { ...((raw.ui ?? {}) as object), locale } }
    this.cache = next
    await writeRawConfig(this.file, next)
  }
}
