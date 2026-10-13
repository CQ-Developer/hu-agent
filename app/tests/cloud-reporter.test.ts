/** 上报队列单测（design 5.10.1）：未登录不入队、批量、位点推进、退避、清空与哈希盐。 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UsageReporter, type TelemetryEvent } from '../src/main/cloud/reporter'
import type { CloudConfig } from '../src/main/cloud/store'
import type { WorkspacePaths } from '../src/main/workspace'

class FakeCloud {
  loggedIn = true
  batches: TelemetryEvent[][] = []
  fail = false

  async isLoggedIn(): Promise<boolean> {
    return this.loggedIn
  }

  async config(): Promise<CloudConfig> {
    return { serverUrl: 'http://127.0.0.1:8080', deviceId: 'device-test' }
  }

  async request(_path: string, options: { body?: unknown }): Promise<unknown> {
    if (this.fail) throw new Error('网络不可达')
    this.batches.push((options.body as { events: TelemetryEvent[] }).events)
    return { accepted: 0, duplicated: 0, rejected: 0, sanitized: 0 }
  }
}

const INPUT = {
  sessionId: 'sess-1',
  provider: 'deepseek',
  model: 'deepseek-chat',
  purpose: 'primary' as const,
  inputTokens: 100,
  outputTokens: 20,
  durationMs: 500,
  status: 'success' as const,
}

describe('UsageReporter', () => {
  let dir: string
  let workspace: WorkspacePaths
  let cloud: FakeCloud
  let reporter: UsageReporter

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-telemetry-'))
    const root = join(dir, 'workspace')
    workspace = {
      id: 'ws_test',
      name: 'test',
      root,
      huDir: join(root, '.hu'),
      sessionDir: join(root, '.hu', 'sessions'),
      artifactDir: join(root, '.hu', 'sessions', 'artifacts'),
      auditFile: join(root, '.hu', 'logs', 'audit.jsonl'),
      settingsFile: join(root, '.hu', 'settings.json'),
    }
    cloud = new FakeCloud()
    reporter = new UsageReporter(cloud, '0.1.0', { batchSize: 2 })
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function readQueue(): Promise<TelemetryEvent[]> {
    const raw = await readFile(join(workspace.huDir, 'telemetry', 'queue.jsonl'), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TelemetryEvent)
  }

  it('未登录时不入队', async () => {
    cloud.loggedIn = false
    expect(await reporter.enqueue(workspace, INPUT)).toBe(false)
    expect(await reporter.pendingCount(workspace)).toBe(0)
  })

  it('入队后写入事件与私有字段，pending 可读', async () => {
    expect(await reporter.enqueue(workspace, INPUT)).toBe(true)
    const events = await readQueue()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      deviceId: 'device-test',
      appVersion: '0.1.0',
      provider: 'deepseek',
      purpose: 'primary',
      workspaceId: null,
      teamId: null,
      requests: 1,
    })
    expect(events[0]?.eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(events[0]?.sessionIdHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await reporter.pendingCount(workspace)).toBe(1)
  })

  it('批量上报按位点推进，重复 flush 不重发', async () => {
    for (let index = 0; index < 5; index += 1) await reporter.enqueue(workspace, INPUT)
    const first = await reporter.flush(workspace, { force: true })
    expect(first.sent).toBe(5)
    expect(first.pending).toBe(0)
    expect(cloud.batches.map((batch) => batch.length)).toEqual([2, 2, 1])

    const second = await reporter.flush(workspace, { force: true })
    expect(second.sent).toBe(0)
    expect(cloud.batches).toHaveLength(3)
  })

  it('失败后记录退避：非强制 flush 不再立即请求，force 可重试', async () => {
    await reporter.enqueue(workspace, INPUT)
    cloud.fail = true
    const failed = await reporter.flush(workspace, { force: true })
    expect(failed.error).toBe('网络不可达')
    expect(failed.pending).toBe(1)

    const skipped = await reporter.flush(workspace)
    expect(skipped.sent).toBe(0)
    expect(skipped.error).toBeUndefined()
    expect(cloud.batches).toHaveLength(0)

    cloud.fail = false
    const forced = await reporter.flush(workspace, { force: true })
    expect(forced.sent).toBe(1)
    expect(forced.pending).toBe(0)
  })

  it('会话哈希带每工作空间盐且可复现', async () => {
    const first = await reporter.sessionHash(workspace, 'sess-1')
    const second = await reporter.sessionHash(workspace, 'sess-1')
    const other = await reporter.sessionHash(workspace, 'sess-2')
    expect(first).toBe(second)
    expect(first).not.toBe(other)
    // 盐已持久化：换一个 reporter 实例仍然一致
    const another = new UsageReporter(cloud, '0.1.0')
    expect(await another.sessionHash(workspace, 'sess-1')).toBe(first)
  })

  it('清空队列后 pending 归零', async () => {
    await reporter.enqueue(workspace, INPUT)
    await reporter.clear(workspace)
    expect(await reporter.pendingCount(workspace)).toBe(0)
  })

  it('超过上限时丢最旧并重置位点', async () => {
    const tiny = new UsageReporter(cloud, '0.1.0', { limitBytes: 600 })
    for (let index = 0; index < 6; index += 1) {
      await tiny.enqueue(workspace, { ...INPUT, sessionId: `sess-${index}` })
    }
    const events = await readQueue()
    expect(events.length).toBeLessThan(6)
    expect(events.length).toBeGreaterThan(0)
    // 保留的是最新的
    expect(events[events.length - 1]?.sessionIdHash).toBe(await tiny.sessionHash(workspace, 'sess-5'))
    expect(events[0]?.sessionIdHash).not.toBe(await tiny.sessionHash(workspace, 'sess-0'))
    expect(await tiny.pendingCount(workspace)).toBe(events.length)
  })

  it('损坏行不影响后续行解析', async () => {
    await reporter.enqueue(workspace, INPUT)
    const file = join(workspace.huDir, 'telemetry', 'queue.jsonl')
    const raw = await readFile(file, 'utf8')
    await writeFile(file, `{broken-json\n${raw}`, 'utf8')
    const result = await reporter.flush(workspace, { force: true })
    expect(result.sent).toBe(1)
  })
})
