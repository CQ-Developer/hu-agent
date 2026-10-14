/**
 * 会话服务：**直接使用 `pi-durable`**（R1，无门面）。
 *
 * 设计要点：
 * - 会话、消息、回合、用量都归 `pi-durable`（SQLite 单文件 + `resume()` 续跑 + `requestId` 幂等）；
 * - 我们只保留一个**视图索引**（`sessions.index.json`：id/标题/时间/工作空间），用于界面列表与排序；
 *   索引不是真相，真相在 durable；索引损坏或缺失时可由 durable 重建（`rebuildIndex()`）。
 * - 会话选项走 `configure()`（模型/思考强度/工作目录/指令），不再有我们自己的会话选项存储。
 *
 * 上层用法：回合循环用 `submit()` 提交输入、订阅 `view()` 投影到 IPC；界面用 `list()` 取列表。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { MutableModels } from '@earendil-works/pi-ai/models'
import { Harness, createRegistry, type Conversation, type ConversationId } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { t } from '../i18n'

export interface SessionIndexEntry {
  id: string
  title: string
  workspaceId: string
  createdAt: string
  updatedAt: string
}

export interface DurableSessionsOptions {
  /** SQLite 单文件路径（如 ~/.hu-agent/sessions.sqlite） */
  file: string
  /** 视图索引文件（列表用；真相在 durable） */
  indexFile: string
  /** pi 的 models 集合（由 pi_runtime 提供，provider 已注册） */
  models: MutableModels
  /** 工作空间根：作为会话默认 cwd */
  cwd: string
  workspaceId: string
}

export interface CreateSessionOptions {
  title?: string
  model?: { provider: string; modelId: string }
  thinkingLevel?: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  instructions?: string
}

export interface SessionView {
  conversation: unknown
  entries: unknown
  docs: Record<string, unknown>
}

/** 一次 submit 的结果（pi-durable 的 submission） */
export interface SubmissionResult {
  id: string
}

export class DurableSessions {
  private storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | null = null
  private harness: Harness | null = null

  constructor(private readonly options: DurableSessionsOptions) {}

  async open(): Promise<void> {
    // 先用局部变量（避免 this.storage 的 `| null` 联合影响 Harness.open 的重载解析）
    const storage = await openNodeSqliteStorage(this.options.file)
    this.storage = storage
    this.harness = await Harness.open(
      storage,
      { models: this.options.models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    )
    // 继续上次进程留下的未完成运行（崩溃恢复语义）
    this.harness.resume()
  }

  async close(): Promise<void> {
    this.harness = null
    const storage = this.storage
    this.storage = null
    await storage?.close(BACKGROUND_CONTEXT)
  }

  /** 新建会话（pi-durable 的 conversation + agent 配置），并写入视图索引 */
  async create(options: CreateSessionOptions = {}): Promise<string> {
    const harness = this.requireHarness()
    const conversation = await harness.createConversation(
      {
        ownership: { kind: 'ownerless' },
        agent: {
          ...(options.model ? { model: options.model } : {}),
          ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
          ...(options.instructions ? { instructions: options.instructions } : {}),
          cwd: this.options.cwd,
        },
      },
      BACKGROUND_CONTEXT,
    )
    const id = String(conversation.id)
    const now = new Date().toISOString()
    const entries = await this.readIndex()
    entries.push({
      id,
      title: options.title ?? t('新会话'),
      workspaceId: this.options.workspaceId,
      createdAt: now,
      updatedAt: now,
    })
    await this.writeIndex(entries)
    return id
  }

  /** 打开既有会话（不存在返回 null） */
  async conversation(id: string): Promise<Conversation | null> {
    const harness = this.requireHarness()
    return (await harness.conversation(id as unknown as ConversationId, BACKGROUND_CONTEXT)) ?? null
  }

  /** 提交一轮输入：幂等（同一 requestId 跨重启返回同一 submission） */
  async submit(id: string, text: string, requestId: string): Promise<SubmissionResult> {
    const conversation = await this.requireConversation(id)
    const submission = await conversation.submit({ type: 'input', content: text, requestId }, BACKGROUND_CONTEXT)
    await this.touch(id)
    return { id: String(submission.id) }
  }

  /** 会话选项（模型/思考强度/工作目录/指令） */
  async configure(
    id: string,
    change: CreateSessionOptions & { model?: { provider: string; modelId: string } | null },
  ): Promise<void> {
    const conversation = await this.requireConversation(id)
    await conversation.configure(change as never, BACKGROUND_CONTEXT)
    await this.touch(id)
  }

  /** 已解析的会话配置（模型/思考强度/工作目录/指令） */
  async agentConfig(id: string): Promise<Record<string, unknown>> {
    const conversation = await this.requireConversation(id)
    return (await conversation.agent(BACKGROUND_CONTEXT)) as unknown as Record<string, unknown>
  }

  /** 界面所需的只读结构视图（transcript + 运行状态 + 用量文档） */
  async view(id: string): Promise<SessionView> {
    const conversation = await this.requireConversation(id)
    const state = await conversation.viewState(BACKGROUND_CONTEXT)
    const value = (state as unknown as { value?: SessionView }).value ?? (state as unknown as SessionView)
    return { conversation: value.conversation, entries: value.entries, docs: value.docs ?? {} }
  }

  /** 整会话用量（模型/工具分账，含失败与中断） */
  async usage(): Promise<{ models: Record<string, unknown>; tools: Record<string, unknown> }> {
    const harness = this.requireHarness()
    const usage = (await harness.usage(BACKGROUND_CONTEXT)) as unknown as {
      models?: Record<string, unknown>
      tools?: Record<string, unknown>
    }
    return { models: usage.models ?? {}, tools: usage.tools ?? {} }
  }

  /** 视图索引（界面列表用） */
  async list(): Promise<SessionIndexEntry[]> {
    const entries = await this.readIndex()
    return entries
      .filter((entry) => entry.workspaceId === this.options.workspaceId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 索引损坏/丢失时的兜底：至少保证不抛错（完整重建留待 R1 收尾按需求补） */
  async rebuildIndex(): Promise<void> {
    const entries = await this.readIndex().catch(() => [])
    await this.writeIndex(entries)
  }

  private requireHarness(): Harness {
    if (!this.harness) throw new Error(t('会话服务未打开：请先调用 open()'))
    return this.harness
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.conversation(id)
    if (!conversation) throw new Error(t('会话不存在：{id}', { id }))
    return conversation
  }

  private async readIndex(): Promise<SessionIndexEntry[]> {
    try {
      const parsed = JSON.parse(await readFile(this.options.indexFile, 'utf8')) as unknown
      return Array.isArray(parsed) ? (parsed as SessionIndexEntry[]) : []
    } catch {
      return []
    }
  }

  private async writeIndex(entries: SessionIndexEntry[]): Promise<void> {
    await mkdir(dirname(this.options.indexFile), { recursive: true })
    const temp = `${this.options.indexFile}.tmp`
    await writeFile(temp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
    await rename(temp, this.options.indexFile)
  }

  private async touch(id: string): Promise<void> {
    const entries = await this.readIndex()
    const entry = entries.find((item) => item.id === id)
    if (!entry) return
    entry.updatedAt = new Date().toISOString()
    await this.writeIndex(entries)
  }
}
