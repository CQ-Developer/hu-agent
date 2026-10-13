/** 本地日志（design 9.4）：写入 ~/.hu-agent/logs/app.log，10MB × 5 滚动。
 *
 * 主进程启动时安装，劫持 console 的 log/warn/error，同时写文件与终端。
 * 采用同步追加：单条日志体量小、频率低，换来崩溃时尾部日志不丢（诊断包依赖这一点）；
 * 文件大小检查做了节流（默认 5 秒一次），避免每条日志都 stat。
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { globalDir } from './config/paths'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_KEEP_FILES = 5
const SIZE_CHECK_INTERVAL_MS = 5000

export function logDir(): string {
  return join(globalDir(), 'logs')
}

export function logFile(): string {
  return join(logDir(), 'app.log')
}

export class FileLogger {
  private installed = false
  private readonly original = { log: console.log, warn: console.warn, error: console.error }
  private readonly file: string
  private readonly maxBytes: number
  private readonly keepFiles: number
  private readonly sizeCheckIntervalMs: number
  private lastSizeCheck = 0

  constructor(options: { file?: string; maxBytes?: number; keepFiles?: number; sizeCheckIntervalMs?: number } = {}) {
    this.file = options.file ?? logFile()
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.keepFiles = options.keepFiles ?? DEFAULT_KEEP_FILES
    this.sizeCheckIntervalMs = options.sizeCheckIntervalMs ?? SIZE_CHECK_INTERVAL_MS
  }

  install(): void {
    if (this.installed) return
    this.installed = true
    mkdirSync(logDir(), { recursive: true })
    console.log = (...args: unknown[]) => {
      this.original.log(...args)
      this.append('INFO', formatArgs(args))
    }
    console.warn = (...args: unknown[]) => {
      this.original.warn(...args)
      this.append('WARN', formatArgs(args))
    }
    console.error = (...args: unknown[]) => {
      this.original.error(...args)
      this.append('ERROR', formatArgs(args))
    }
  }

  /** 写一条日志（同步落盘）。 */
  append(level: string, message: string): void {
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      this.rotateIfNeeded()
      appendFileSync(this.file, `${new Date().toISOString()} ${level.padEnd(5)} ${truncate(message)}\n`, 'utf8')
    } catch {
      // 日志失败不能影响业务
    }
  }

  close(): void {
    // 同步写入，无需 flush；保留接口以便未来切换异步实现
  }

  private rotateIfNeeded(): void {
    const now = Date.now()
    if (now - this.lastSizeCheck < this.sizeCheckIntervalMs) return
    this.lastSizeCheck = now
    try {
      if (!existsSync(this.file) || statSync(this.file).size < this.maxBytes) return
    } catch {
      return
    }
    // app.log → app.log.1 → app.log.2 …，最多保留 keepFiles 份
    try {
      rmSync(`${this.file}.${this.keepFiles}`, { force: true })
    } catch {
      // 忽略
    }
    for (let index = this.keepFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.file : `${this.file}.${index - 1}`
      const target = `${this.file}.${index}`
      try {
        if (existsSync(source)) renameSync(source, target)
      } catch {
        // 单份滚动失败不阻塞
      }
    }
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((value) => {
      if (typeof value === 'string') return value
      if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    })
    .join(' ')
}

function truncate(text: string): string {
  return text.length > 8000 ? `${text.slice(0, 8000)}…（截断）` : text
}
