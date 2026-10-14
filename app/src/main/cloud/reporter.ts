/** 用量上报队列（design 5.10.1）：每工作空间 telemetry/queue.jsonl + 确认位点。
 *
 * - 未登录不入队（隐私默认）
 * - 批量 ≤ 100 条，成功推进确认位点；失败指数退避（1m/5m/30m/2h，上限 1 天）
 * - 保留 7 天 / 上限 50MB，超出丢最旧并记日志
 * - sessionIdHash 带每工作空间随机盐，不可反推（design 5.10.2）
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { WorkspacePaths } from '../workspace'
import type { TelemetryInput } from '../usage/telemetry'
import type { CloudConfig } from './store'
import { uuidv7 } from './uuidv7'
import { t } from '../i18n'

/** 上报所需的最小云端能力（CloudClient 满足），便于单测替换。 */
export interface TelemetryClient {
  isLoggedIn(): Promise<boolean>
  config(): Promise<CloudConfig>
  request(path: string, options: { method?: string; body?: unknown; timeoutMs?: number }): Promise<unknown>
}

export interface TelemetryEvent {
  eventId: string
  occurredAt: string
  deviceId: string
  appVersion: string
  workspaceId: string | null
  teamId: string | null
  sessionIdHash: string
  purpose: 'primary' | 'fast'
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  requests: number
  durationMs?: number
  status: 'success' | 'error'
  errorCode?: string
}

export interface FlushResult {
  sent: number
  pending: number
  error?: string
}

export interface UsageReporterOptions {
  limitBytes?: number
  retentionMs?: number
  batchSize?: number
}

const DEFAULT_LIMIT_BYTES = 50 * 1024 * 1024
const DEFAULT_RETENTION_MS = 7 * 24 * 3600_000
const COMPACT_THRESHOLD_BYTES = 5 * 1024 * 1024
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 24 * 3600_000]

interface ReporterState {
  failureCount: number
  lastAttemptAt?: number
}

export class UsageReporter {
  private readonly limitBytes: number
  private readonly retentionMs: number
  private readonly batchSize: number
  private flushing = false

  constructor(
    private readonly cloud: TelemetryClient,
    private readonly appVersion: string,
    options: UsageReporterOptions = {},
  ) {
    this.limitBytes = options.limitBytes ?? DEFAULT_LIMIT_BYTES
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.batchSize = options.batchSize ?? 100
  }

  /** 记录一次模型调用；未登录时直接丢弃（不入队）。 */
  async enqueue(ws: WorkspacePaths, input: TelemetryInput): Promise<boolean> {
    if (!(await this.cloud.isLoggedIn())) return false
    const config = await this.cloud.config()
    const event: TelemetryEvent = {
      eventId: uuidv7(),
      occurredAt: new Date().toISOString(),
      deviceId: config.deviceId,
      appVersion: this.appVersion,
      // 工作空间的服务端 UUID 在云同步（阶段 6）建立后才有，当前统一置空
      workspaceId: null,
      teamId: null,
      sessionIdHash: await this.sessionHash(ws, input.sessionId),
      purpose: input.purpose,
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? 0,
      requests: 1,
      durationMs: input.durationMs,
      status: input.status,
      errorCode: input.errorCode,
    }
    const file = this.queueFile(ws)
    await mkdir(this.telemetryDir(ws), { recursive: true })
    await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8')
    await this.trim(ws)
    return true
  }

  async pendingCount(ws: WorkspacePaths): Promise<number> {
    const file = this.queueFile(ws)
    try {
      const { size } = await stat(file)
      const pos = await this.readPos(ws)
      if (pos >= size) return 0
      const tail = await readFrom(file, pos)
      return tail.split('\n').filter((line) => line.trim().length > 0).length
    } catch {
      return 0
    }
  }

  /** 上报一批或多批；`force` 用于用户手动触发，忽略退避。 */
  async flush(ws: WorkspacePaths, options: { force?: boolean } = {}): Promise<FlushResult> {
    if (this.flushing) return { sent: 0, pending: await this.pendingCount(ws) }
    if (!(await this.cloud.isLoggedIn())) {
      return { sent: 0, pending: await this.pendingCount(ws), error: t('未登录') }
    }

    const state = await this.readState(ws)
    if (!options.force && !this.isDue(state)) {
      return { sent: 0, pending: await this.pendingCount(ws) }
    }

    this.flushing = true
    let sent = 0
    try {
      let pos = await this.readPos(ws)
      for (;;) {
        const batch = await readBatch(this.queueFile(ws), pos, this.batchSize)
        if (batch.events.length === 0) break
        try {
          await this.cloud.request('/api/v1/usage:batch', {
            method: 'POST',
            body: { events: batch.events },
            timeoutMs: 30_000,
          })
        } catch (error) {
          await this.writeState(ws, {
            failureCount: (state.failureCount ?? 0) + 1,
            lastAttemptAt: Date.now(),
          })
          return {
            sent,
            pending: await this.pendingCount(ws),
            error: error instanceof Error ? error.message : String(error),
          }
        }
        sent += batch.events.length
        pos = batch.endOffset
        await this.writePos(ws, pos)
        if (batch.events.length < this.batchSize) break
      }
      await this.writeState(ws, { failureCount: 0, lastAttemptAt: Date.now() })
      await this.maybeCompact(ws)
      return { sent, pending: await this.pendingCount(ws) }
    } finally {
      this.flushing = false
    }
  }

  async clear(ws: WorkspacePaths): Promise<void> {
    await rm(this.queueFile(ws), { force: true })
    await rm(this.posFile(ws), { force: true })
    await rm(this.stateFile(ws), { force: true })
  }

  /** 定时调用：只处理到达重试时间且有积压的工作空间。 */
  async tick(workspaces: WorkspacePaths[]): Promise<void> {
    if (!(await this.cloud.isLoggedIn())) return
    for (const ws of workspaces) {
      try {
        const [state, pending] = await Promise.all([this.readState(ws), this.pendingCount(ws)])
        if (pending === 0 || !this.isDue(state)) continue
        await this.flush(ws, { force: true })
      } catch (error) {
        console.warn(t('[telemetry] 上报失败（{name}）：', { name: ws.name }), error)
      }
    }
  }

  async sessionHash(ws: WorkspacePaths, sessionId: string): Promise<string> {
    const salt = await this.salt(ws)
    return `sha256:${createHash('sha256').update(`${salt}:${sessionId}`).digest('hex')}`
  }

  private telemetryDir(ws: WorkspacePaths): string {
    return join(ws.huDir, 'telemetry')
  }

  private queueFile(ws: WorkspacePaths): string {
    return join(this.telemetryDir(ws), 'queue.jsonl')
  }

  private posFile(ws: WorkspacePaths): string {
    return join(this.telemetryDir(ws), 'queue.pos')
  }

  private stateFile(ws: WorkspacePaths): string {
    return join(this.telemetryDir(ws), 'state.json')
  }

  private async salt(ws: WorkspacePaths): Promise<string> {
    const file = join(this.telemetryDir(ws), 'salt')
    try {
      return (await readFile(file, 'utf8')).trim()
    } catch {
      const generated = randomBytes(16).toString('hex')
      await mkdir(this.telemetryDir(ws), { recursive: true })
      await writeFile(file, generated, 'utf8')
      return generated
    }
  }

  private async readPos(ws: WorkspacePaths): Promise<number> {
    try {
      return Number.parseInt((await readFile(this.posFile(ws), 'utf8')).trim(), 10) || 0
    } catch {
      return 0
    }
  }

  private async writePos(ws: WorkspacePaths, value: number): Promise<void> {
    await mkdir(this.telemetryDir(ws), { recursive: true })
    await writeFile(this.posFile(ws), String(value), 'utf8')
  }

  private async readState(ws: WorkspacePaths): Promise<ReporterState> {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile(ws), 'utf8')) as ReporterState
      return { failureCount: parsed.failureCount ?? 0, lastAttemptAt: parsed.lastAttemptAt }
    } catch {
      return { failureCount: 0 }
    }
  }

  private async writeState(ws: WorkspacePaths, state: ReporterState): Promise<void> {
    await mkdir(this.telemetryDir(ws), { recursive: true })
    await writeFile(this.stateFile(ws), JSON.stringify(state), 'utf8')
  }

  private isDue(state: ReporterState): boolean {
    if (!state.lastAttemptAt) return true
    const backoff = BACKOFF_MS[Math.min(state.failureCount, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[0]!
    return Date.now() - state.lastAttemptAt >= backoff
  }

  /** 已发送部分占多数时压实队列文件，避免无限增长。 */
  private async maybeCompact(ws: WorkspacePaths): Promise<void> {
    const file = this.queueFile(ws)
    try {
      const { size } = await stat(file)
      const pos = await this.readPos(ws)
      if (size < COMPACT_THRESHOLD_BYTES || pos < size / 2) return
      const tail = await readFrom(file, pos)
      const temp = `${file}.tmp`
      await writeFile(temp, tail, 'utf8')
      await rename(temp, file)
      await this.writePos(ws, 0)
    } catch {
      // 压实失败不影响上报
    }
  }

  /** 超限/超期时丢最旧（design 5.10.1）；重写文件并重置位点。 */
  private async trim(ws: WorkspacePaths): Promise<void> {
    const file = this.queueFile(ws)
    let size: number
    try {
      size = (await stat(file)).size
    } catch {
      return
    }
    if (size <= this.limitBytes) return

    const content = await readFile(file, 'utf8')
    const lines = content.split('\n').filter((line) => line.trim().length > 0)
    const cutoff = Date.now() - this.retentionMs
    const kept: string[] = []
    let bytes = 0
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!
      const occurred = Date.parse((JSON.parse(line) as TelemetryEvent).occurredAt)
      if (Number.isFinite(occurred) && occurred < cutoff) break
      bytes += Buffer.byteLength(line) + 1
      if (bytes > this.limitBytes * 0.8) break
      kept.push(line)
    }
    kept.reverse()
    const dropped = lines.length - kept.length
    console.warn(t('[telemetry] 队列超过上限，丢弃最旧 {dropped} 条记录（{name}）', { dropped, name: ws.name }))
    const temp = `${file}.tmp`
    await writeFile(temp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8')
    await rename(temp, file)
    await this.writePos(ws, 0)
  }
}

/** 从指定字节位点读最多 maxLines 条完整行；尾部不完整的行留给下次。 */
async function readBatch(
  file: string,
  startOffset: number,
  maxLines: number,
): Promise<{ events: TelemetryEvent[]; endOffset: number }> {
  return new Promise((resolve, reject) => {
    const events: TelemetryEvent[] = []
    let buffer = ''
    let offset = startOffset
    let done = false
    const stream = createReadStream(file, { start: startOffset, encoding: 'utf8' })
    const finish = (): void => {
      if (done) return
      done = true
      stream.destroy()
      resolve({ events, endOffset: offset })
    }
    stream.on('data', (chunk: string | Buffer) => {
      buffer += chunk.toString()
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        offset += Buffer.byteLength(line) + 1
        if (line.trim().length === 0) continue
        try {
          events.push(JSON.parse(line) as TelemetryEvent)
        } catch {
          // 损坏行跳过
        }
        if (events.length >= maxLines) {
          finish()
          return
        }
      }
    })
    stream.on('end', finish)
    stream.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}

async function readFrom(file: string, start: number): Promise<string> {
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file, { start })
    stream.on('data', (chunk: string | Buffer) => chunks.push(Buffer.from(chunk)))
    stream.on('end', resolve)
    stream.on('error', reject)
  })
  return Buffer.concat(chunks).toString('utf8')
}
