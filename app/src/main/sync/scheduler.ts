/** 定时同步配置与调度（design 5.11.5）。
 *
 * 档位存于 `<ws>/.hu/sync/settings.json`（本地专用，不参与快照）。
 * 规则：已登录 + 无进行中同步（单飞锁）；冲突时暂停；失败静默重试一次；
 * 连续失败 3 次通过事件提醒 UI；无本地变更时不做写请求。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { SyncStatusView } from '../../shared/ipc'
import type { WorkspacePaths } from '../workspace'
import { t } from '../i18n'

export type SyncSchedule = 'off' | '15m' | '30m' | '1h' | '6h' | '24h'

const SYNC_SCHEDULES: { value: SyncSchedule; label: string; minutes: number }[] = [
  { value: 'off', label: t('关闭'), minutes: 0 },
  { value: '15m', label: t('每 15 分钟'), minutes: 15 },
  { value: '30m', label: t('每 30 分钟'), minutes: 30 },
  { value: '1h', label: t('每 1 小时'), minutes: 60 },
  { value: '6h', label: t('每 6 小时'), minutes: 360 },
  { value: '24h', label: t('每 24 小时'), minutes: 1440 },
]

export interface SyncSettings {
  schedule: SyncSchedule
  includeSessions: boolean
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = { schedule: 'off', includeSessions: true }

export function scheduleMinutes(schedule: SyncSchedule): number {
  return SYNC_SCHEDULES.find((item) => item.value === schedule)?.minutes ?? 0
}

export async function loadSyncSettings(workspace: WorkspacePaths): Promise<SyncSettings> {
  try {
    const parsed = JSON.parse(
      await readFile(join(workspace.huDir, 'sync', 'settings.json'), 'utf8'),
    ) as Partial<SyncSettings>
    const schedule = SYNC_SCHEDULES.some((item) => item.value === parsed.schedule)
      ? (parsed.schedule as SyncSchedule)
      : 'off'
    return { schedule, includeSessions: parsed.includeSessions !== false }
  } catch {
    return { ...DEFAULT_SYNC_SETTINGS }
  }
}

export async function saveSyncSettings(workspace: WorkspacePaths, settings: SyncSettings): Promise<void> {
  const dir = join(workspace.huDir, 'sync')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'settings.json')
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(settings, null, 2), 'utf8')
  await rename(temp, file)
}

export interface SyncSchedulerDeps {
  /** 取当前工作空间的同步引擎并执行一次自动同步（返回状态） */
  run: () => Promise<SyncStatusView>
  /** 每次自动同步结束后回调（用于广播 UI） */
  onResult?: (view: SyncStatusView) => void
  /** 冲突时是否暂停：由调用方根据状态判断 */
  shouldPause?: (view: SyncStatusView) => boolean
}

/** 定时同步调度器：单飞、冲突暂停、失败重试一次、连续 3 次失败上报。 */
export class SyncScheduler {
  private timer?: NodeJS.Timeout
  private running = false
  private consecutiveFailures = 0
  private schedule: SyncSchedule = 'off'

  constructor(private readonly deps: SyncSchedulerDeps) {}

  get current(): SyncSchedule {
    return this.schedule
  }

  get failures(): number {
    return this.consecutiveFailures
  }

  /** 设置档位；off 表示停止。 */
  configure(schedule: SyncSchedule): void {
    this.schedule = schedule
    this.stop()
    const minutes = scheduleMinutes(schedule)
    if (minutes <= 0) return
    this.timer = setInterval(() => void this.tick(), minutes * 60_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 手动触发一次（测试与「立即同步」复用）；同一时刻只允许一次。 */
  async tick(): Promise<SyncStatusView | null> {
    if (this.running) return null // 单飞锁
    this.running = true
    try {
      let view = await this.deps.run()
      if (view.status === 'error') {
        // 失败静默重试一次（design 5.11.5）
        view = await this.deps.run()
      }
      this.consecutiveFailures = view.status === 'error' ? this.consecutiveFailures + 1 : 0
      if (view.status === 'error' && this.consecutiveFailures >= 3) {
        view = { ...view, lastError: `${view.lastError ?? t('同步失败')}（已连续失败 ${this.consecutiveFailures} 次）` }
      }
      this.deps.onResult?.(view)
      if (view.status === 'conflict' || this.deps.shouldPause?.(view)) {
        // 冲突时暂停定时同步，直到用户处理（design 5.11.5 第 4 条）
        this.stop()
      }
      return view
    } finally {
      this.running = false
    }
  }
}
