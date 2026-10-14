/** 定时同步单测（design 5.11.5）：档位、单飞、冲突暂停、失败重试。 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SyncStatusView } from '../src/shared/ipc'
import {
  DEFAULT_SYNC_SETTINGS,
  SyncScheduler,
  loadSyncSettings,
  saveSyncSettings,
  scheduleMinutes,
} from '../src/main/sync/scheduler'
import type { WorkspacePaths } from '../src/main/workspace'

function view(status: SyncStatusView['status'], lastError?: string): SyncStatusView {
  return {
    status,
    localFiles: 1,
    localBytes: 10,
    localDigest: 'sha256:x',
    lastError,
  }
}

function workspaceOf(root: string): WorkspacePaths {
  return {
    id: 'ws',
    name: 'test',
    root,
    huDir: join(root, '.hu'),
    sessionDir: join(root, '.hu', 'sessions'),
    artifactDir: join(root, '.hu', 'sessions', 'artifacts'),
    auditFile: join(root, '.hu', 'logs', 'audit.jsonl'),
    settingsFile: join(root, '.hu', 'settings.json'),
  }
}

describe('同步档位设置', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-sync-settings-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('档位映射到分钟数', () => {
    expect(scheduleMinutes('off')).toBe(0)
    expect(scheduleMinutes('15m')).toBe(15)
    expect(scheduleMinutes('24h')).toBe(1440)
  })

  it('默认关闭且可持久化', async () => {
    const workspace = workspaceOf(dir)
    expect(await loadSyncSettings(workspace)).toEqual(DEFAULT_SYNC_SETTINGS)

    await saveSyncSettings(workspace, { schedule: '6h', includeSessions: false })
    expect(await loadSyncSettings(workspace)).toEqual({ schedule: '6h', includeSessions: false })

    // 磁盘损坏时回落默认值
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir(join(dir, '.hu', 'sync'), { recursive: true })
    await writeFile(join(dir, '.hu', 'sync', 'settings.json'), '{broken', 'utf8')
    expect(await loadSyncSettings(workspace)).toEqual(DEFAULT_SYNC_SETTINGS)
  })
})

describe('SyncScheduler', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('关闭档位不启动定时器', () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => view('up-to-date'))
    const scheduler = new SyncScheduler({ run })
    scheduler.configure('off')
    vi.advanceTimersByTime(60 * 60_000)
    expect(run).not.toHaveBeenCalled()
  })

  it('按档位周期执行并回调结果', async () => {
    vi.useFakeTimers()
    const results: SyncStatusView[] = []
    const run = vi.fn(async () => view('up-to-date'))
    const scheduler = new SyncScheduler({ run, onResult: (result) => results.push(result) })

    scheduler.configure('15m')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(2)

    scheduler.stop()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('冲突时暂停，重新配置后恢复', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => view('conflict'))
    const scheduler = new SyncScheduler({ run })
    scheduler.configure('15m')

    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)

    // 冲突后已暂停：继续推进时间不应再执行
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(run).toHaveBeenCalledTimes(1)

    scheduler.configure('15m') // 用户处理后重新武装
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('失败静默重试一次，连续 3 次失败在错误信息中提醒', async () => {
    vi.useFakeTimers()
    let calls = 0
    const run = async (): Promise<SyncStatusView> => {
      calls += 1
      return view('error', '服务端不可达')
    }
    const scheduler = new SyncScheduler({ run })
    scheduler.configure('15m')

    await vi.advanceTimersByTimeAsync(15 * 60_000) // 1 次失败 + 重试 1 次
    expect(calls).toBe(2)
    expect(scheduler.failures).toBe(1)

    await vi.advanceTimersByTimeAsync(15 * 60_000) // +2 = 4
    expect(calls).toBe(4)
    expect(scheduler.failures).toBe(2)

    const results: SyncStatusView[] = []
    const scheduler2 = new SyncScheduler({ run, onResult: (result) => results.push(result) })
    scheduler2.configure('15m')
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(scheduler2.failures).toBe(3)
    expect(results.at(-1)?.lastError).toContain('已连续失败 3 次')
  })

  it('成功一次后失败计数清零', async () => {
    vi.useFakeTimers()
    let fail = true
    const run = async (): Promise<SyncStatusView> => (fail ? view('error', 'x') : view('up-to-date'))
    const scheduler = new SyncScheduler({ run })
    scheduler.configure('15m')

    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(scheduler.failures).toBe(1)
    fail = false
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(scheduler.failures).toBe(0)
  })

  it('单飞锁：进行中的同步不会被并发触发', async () => {
    let release: (() => void) | null = null
    const run = (): Promise<SyncStatusView> =>
      new Promise((resolve) => {
        release = () => resolve(view('up-to-date'))
      })
    const scheduler = new SyncScheduler({ run })

    const first = scheduler.tick()
    expect(await scheduler.tick()).toBeNull() // 被单飞锁挡住
    release?.()
    await first
  })
})
