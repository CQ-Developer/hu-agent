/** 权限决策审计（design 5.5.7）：追加写入 <workspace>/.hu/logs/audit.jsonl。 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface AuditEntry {
  ts: string
  sessionId: string
  turnId: string
  toolCallId: string
  tool: string
  /** 只记录命令或路径等摘要，不记录文件内容 */
  summary: string
  decision: 'allow' | 'deny' | 'allow_once' | 'allow_session' | 'allow_always'
  scope: string
  argsDigest: string
}

export function digestArgs(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 32)}`
}

export class AuditLog {
  constructor(private readonly file: string) {}

  async record(entry: Omit<AuditEntry, 'ts' | 'argsDigest'> & { args?: unknown }): Promise<void> {
    const { args, ...rest } = entry
    const line: AuditEntry = {
      ts: new Date().toISOString(),
      argsDigest: digestArgs(args ?? { summary: entry.summary }),
      ...rest,
    }
    await mkdir(dirname(this.file), { recursive: true })
    await appendFile(this.file, `${JSON.stringify(line)}\n`, 'utf8')
  }
}

/** 读取最近 N 条审计记录（用于设置页展示）。 */
export async function readAuditTail(file: string, limit = 50): Promise<AuditEntry[]> {
  try {
    const raw = await readFile(file, 'utf8')
    const lines = raw.trim().split('\n').slice(-Math.max(1, limit))
    const entries: AuditEntry[] = []
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditEntry)
      } catch {
        // 跳过损坏行
      }
    }
    return entries.reverse()
  } catch {
    return []
  }
}
