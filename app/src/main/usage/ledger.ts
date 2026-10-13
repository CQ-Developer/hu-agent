/** 本地用量账本（design 5.10，阶段 1 只落本地，阶段 4 接入上报）。 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface UsageEntry {
  ts: string
  provider: string
  model: string
  role: 'primary' | 'fast'
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  durationMs: number
  status: 'success' | 'error'
  errorCode?: string
}

export interface UsageStats {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }>
}

export class UsageLedger {
  constructor(private readonly file: string) {}

  async record(entry: UsageEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  async readAll(): Promise<UsageEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const entries: UsageEntry[] = []
    for (const text of raw.split('\n')) {
      const trimmed = text.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as UsageEntry)
      } catch {
        // 损坏行跳过
      }
    }
    return entries
  }

  async stats(): Promise<UsageStats> {
    return aggregateUsage(await this.readAll())
  }
}

export function aggregateUsage(entries: UsageEntry[]): UsageStats {
  const stats: UsageStats = {
    calls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    byModel: {},
  }
  for (const entry of entries) {
    stats.calls += 1
    if (entry.status === 'error') stats.errors += 1
    stats.inputTokens += entry.inputTokens
    stats.outputTokens += entry.outputTokens
    stats.cacheReadTokens += entry.cacheReadTokens ?? 0
    const key = `${entry.provider}/${entry.model}`
    const bucket = (stats.byModel[key] ??= { calls: 0, inputTokens: 0, outputTokens: 0 })
    bucket.calls += 1
    bucket.inputTokens += entry.inputTokens
    bucket.outputTokens += entry.outputTokens
  }
  return stats
}
