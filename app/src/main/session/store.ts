/** 会话存储：append-only JSONL + 可重建索引（design 5.3）。 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { LlmMessage, ReasoningEffort, ToolCall } from '../model/types'
import type { MessageLine, SessionIndex, SessionLine, SessionMeta, ToolResultLine } from './types'
import { ulid } from './ulid'

const INDEX_FILE = 'index.json'

export class SessionStore {
  constructor(private readonly sessionDir: string) {}

  private filePath(sessionId: string): string {
    return join(this.sessionDir, `${sessionId}.jsonl`)
  }

  private indexPath(): string {
    return join(this.sessionDir, INDEX_FILE)
  }

  async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true })
  }

  async create(title = '新会话'): Promise<SessionMeta> {
    await this.init()
    const id = ulid()
    const now = new Date().toISOString()
    const meta: SessionMeta = { id, title, createdAt: now, updatedAt: now, messageCount: 0 }
    await this.append(id, { type: 'meta', v: 1, sessionId: id, createdAt: now })

    // 先写文件再读索引：若索引缺失会触发重建（已包含本次会话），否则手动补登
    const index = await this.loadIndex()
    const existing = index.sessions.find((session) => session.id === id)
    if (existing) {
      existing.title = title
    } else {
      index.sessions.unshift(meta)
    }
    await this.saveIndex(index)
    return meta
  }

  async append(sessionId: string, line: SessionLine): Promise<void> {
    const { appendFile } = await import('node:fs/promises')
    await appendFile(this.filePath(sessionId), `${JSON.stringify(line)}\n`, 'utf8')
  }

  async readLines(sessionId: string): Promise<{ lines: SessionLine[]; corrupted: number }> {
    let raw: string
    try {
      raw = await readFile(this.filePath(sessionId), 'utf8')
    } catch {
      return { lines: [], corrupted: 0 }
    }
    const lines: SessionLine[] = []
    let corrupted = 0
    for (const text of raw.split('\n')) {
      const trimmed = text.trim()
      if (!trimmed) continue
      try {
        lines.push(JSON.parse(trimmed) as SessionLine)
      } catch {
        corrupted += 1 // 崩溃导致的尾部残留行：跳过而不是整体失败
      }
    }
    return { lines, corrupted }
  }

  /** 重建模型上下文（design 5.3.2）：message / tool_call / tool_result 按顺序还原。 */
  async loadMessages(sessionId: string, maxMessages = 120): Promise<LlmMessage[]> {
    const { lines } = await this.readLines(sessionId)
    const messages: LlmMessage[] = []
    let currentAssistant: number | null = null

    for (const line of lines) {
      if (line.type === 'message') {
        const content = line.parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('')
        if (line.role === 'assistant') {
          const reasoningPart = line.parts.find((part) => part.type === 'reasoning')
          const reasoningPartText = line.parts
            .filter((part) => part.type === 'reasoning')
            .map((part) => part.text)
            .join('')
          messages.push({
            role: 'assistant',
            content,
            reasoning: reasoningPartText
              ? { text: reasoningPartText, signature: reasoningPart?.type === 'reasoning' ? reasoningPart.signature : undefined }
              : undefined,
          })
          currentAssistant = messages.length - 1
        } else {
          messages.push({ role: line.role, content })
        }
      } else if (line.type === 'tool_call') {
        const call: ToolCall = { id: line.id, name: line.name, input: line.args }
        const existing = currentAssistant === null ? undefined : messages[currentAssistant]
        if (existing && existing.role === 'assistant') {
          existing.toolCalls = [...(existing.toolCalls ?? []), call]
          continue
        }
        messages.push({ role: 'assistant', content: '', toolCalls: [call] })
        currentAssistant = messages.length - 1
      } else if (line.type === 'tool_result') {
        messages.push({ role: 'tool', toolCallId: line.id, content: line.output })
      }
    }

    return messages.length > maxMessages ? messages.slice(messages.length - maxMessages) : messages
  }

  async list(): Promise<SessionMeta[]> {
    const index = await this.loadIndex()
    return index.sessions
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const index = await this.loadIndex()
    const meta = index.sessions.find((item) => item.id === sessionId)
    if (!meta) return
    meta.title = title
    meta.updatedAt = new Date().toISOString()
    await this.saveIndex(index)
  }

  async touch(sessionId: string, messageDelta: number): Promise<void> {
    const index = await this.loadIndex()
    const meta = index.sessions.find((item) => item.id === sessionId)
    if (!meta) return
    meta.updatedAt = new Date().toISOString()
    meta.messageCount += messageDelta
    await this.saveIndex(index)
  }

  /** 会话级模型 / 思考强度；取最后一条 session_options 行（design 5.2.6）。 */
  async loadOptions(sessionId: string): Promise<{ model?: string; reasoningEffort?: ReasoningEffort }> {
    const { lines } = await this.readLines(sessionId)
    let model: string | undefined
    let reasoningEffort: ReasoningEffort | undefined
    for (const line of lines) {
      if (line.type !== 'session_options') continue
      if (line.model) model = line.model
      if (line.reasoningEffort) reasoningEffort = line.reasoningEffort
    }
    return { model, reasoningEffort }
  }

  async setOptions(
    sessionId: string,
    options: { model?: string; reasoningEffort?: ReasoningEffort },
  ): Promise<void> {
    await this.append(sessionId, {
      type: 'session_options',
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      createdAt: new Date().toISOString(),
    })
  }

  private async loadIndex(): Promise<SessionIndex> {
    await this.init()
    try {
      const raw = await readFile(this.indexPath(), 'utf8')
      const parsed = JSON.parse(raw) as SessionIndex
      if (Array.isArray(parsed.sessions)) return parsed
    } catch {
      // 索引缺失或损坏：重建
    }
    return this.rebuildIndex()
  }

  private async saveIndex(index: SessionIndex): Promise<void> {
    const target = this.indexPath()
    const temp = `${target}.tmp`
    await writeFile(temp, JSON.stringify(index, null, 2), 'utf8')
    await rename(temp, target)
  }

  /** 扫描 .jsonl 重建索引（design 5.3.2：索引可重建）。 */
  private async rebuildIndex(): Promise<SessionIndex> {
    const entries = await readdir(this.sessionDir).catch(() => [] as string[])
    const sessions: SessionMeta[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const id = entry.slice(0, -'.jsonl'.length)
      const { lines } = await this.readLines(id)
      const metaLine = lines.find((line) => line.type === 'meta')
      const messageLines = lines.filter((line) => line.type === 'message')
      const createdAt = metaLine?.type === 'meta' ? metaLine.createdAt : new Date().toISOString()
      sessions.push({
        id,
        title: '未命名会话',
        createdAt,
        updatedAt: createdAt,
        messageCount: messageLines.length,
      })
    }
    sessions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    const index: SessionIndex = { sessions }
    await this.saveIndex(index)
    return index
  }
}

export function textOf(message: MessageLine): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

export function isToolResultOk(line: SessionLine): line is ToolResultLine {
  return line.type === 'tool_result' && line.status === 'ok'
}
