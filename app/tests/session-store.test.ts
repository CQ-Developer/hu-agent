import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SessionStore } from '../src/main/session/store'
import type { SessionLine } from '../src/main/session/types'

const now = (): string => new Date().toISOString()

const message = (id: string, role: 'user' | 'assistant', text: string): SessionLine => ({
  type: 'message',
  id,
  role,
  parts: [{ type: 'text', text }],
  createdAt: now(),
})

describe('SessionStore', () => {
  let dir: string
  let store: SessionStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-session-'))
    store = new SessionStore(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('创建会话并写入索引', async () => {
    const meta = await store.create('测试会话')
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(meta.id)
    expect(list[0]?.title).toBe('测试会话')
  })

  it('容忍 JSONL 尾部损坏行', async () => {
    const meta = await store.create()
    await store.append(meta.id, message('m1', 'user', '你好'))
    await writeFile(join(dir, `${meta.id}.jsonl`), '{"type":"partial"', { flag: 'a' })

    const { lines, corrupted } = await store.readLines(meta.id)
    expect(corrupted).toBeGreaterThan(0)
    expect(lines.some((line) => line.type === 'message')).toBe(true)
  })

  it('索引删除后可从 jsonl 重建', async () => {
    const meta = await store.create('重建')
    await store.append(meta.id, message('m1', 'user', '你好'))
    await unlink(join(dir, 'index.json'))

    const list = await store.list()
    expect(list.map((session) => session.id)).toContain(meta.id)
  })

  it('loadMessages 还原 assistant 的 tool 调用与结果', async () => {
    const meta = await store.create()
    await store.append(meta.id, message('m1', 'user', '读文件'))
    await store.append(meta.id, message('a1', 'assistant', '我来读取'))
    await store.append(meta.id, {
      type: 'tool_call',
      id: 'c1',
      name: 'read_file',
      args: { path: 'a.txt' },
      turnId: 't1',
      createdAt: now(),
    })
    await store.append(meta.id, {
      type: 'tool_result',
      id: 'c1',
      status: 'ok',
      output: '文件内容',
      durationMs: 5,
      createdAt: now(),
    })

    const messages = await store.loadMessages(meta.id)
    expect(messages.map((item) => item.role)).toEqual(['user', 'assistant', 'tool'])
    const assistant = messages[1]
    expect(assistant && assistant.role === 'assistant' ? assistant.toolCalls?.[0]?.name : undefined).toBe('read_file')
  })

  it('messageCount 随 touch 增长', async () => {
    const meta = await store.create()
    await store.append(meta.id, message('m1', 'user', 'hi'))
    await store.touch(meta.id, 1)
    const list = await store.list()
    expect(list[0]?.messageCount).toBe(1)
  })

  it('会话选项按最后一条 session_options 生效', async () => {
    const meta = await store.create()
    await store.setOptions(meta.id, { model: 'a/x', reasoningEffort: 'low' })
    await store.setOptions(meta.id, { model: 'b/y' })

    expect(await store.loadOptions(meta.id)).toEqual({ model: 'b/y', reasoningEffort: 'low' })
  })
})
