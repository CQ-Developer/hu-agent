/**
 * 会话服务测试（R1）：直接用 pi-durable，验证上层要用的全部语义。
 *
 * 1. 新建会话 → 提交输入 → `view()` 能看到 transcript 与 pi.usage/pi.agent 文档；
 * 2. `configure()` 的会话选项（思考强度/指令）**跨重开仍在**；
 * 3. 视图索引（列表）按工作空间过滤与时间排序；索引丢失不影响会话（真相在 durable）；
 * 4. 幂等：同一 requestId 重复提交返回同一 submission；
 * 5. `usage()` 可读（faux 下为 0，验证契约）。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DurableSessions } from '../src/main/session/durable'

const MODEL = 'faux-1'

describe('DurableSessions（直接使用 pi-durable）', () => {
  let dir: string
  let file: string
  let indexFile: string
  let sessions: DurableSessions | null = null

  function makeModels() {
    const faux = fauxProvider({ models: [{ id: MODEL, name: 'Faux 1' }] })
    const models = createModels()
    models.setProvider(faux.provider)
    return { models, faux }
  }

  async function open(workspaceId = 'ws_1') {
    const { models, faux } = makeModels()
    const instance = new DurableSessions({
      file,
      indexFile,
      models,
      cwd: dir,
      workspaceId,
    })
    await instance.open()
    return { instance, faux }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-sessions-'))
    file = join(dir, 'sessions.sqlite')
    indexFile = join(dir, 'sessions.index.json')
  })

  afterEach(async () => {
    await sessions?.close().catch(() => undefined)
    sessions = null
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined)
  })

  it('新建 → 提交 → 视图含 transcript 与文档；用量可读', async () => {
    const opened = await open()
    sessions = opened.instance
    opened.faux.setResponses([fauxAssistantMessage([fauxText('收到')])])

    const created = await sessions.create({ title: '第一会话', model: { provider: 'faux', modelId: MODEL } })
    const id = created.id
    expect(id).toBeTruthy()
    expect(created.messageCount).toBe(0)

    await sessions.submit(id, '你好', 'req-1')
    const view = await sessions.view(id)
    expect(view.entries).toBeDefined()
    expect(view.docs['pi.usage']).toBeDefined()
    expect(view.docs['pi.agent']).toBeDefined()

    const usage = await sessions.usage()
    expect(usage.models).toBeDefined()
    expect(usage.tools).toBeDefined()

    const list = await sessions.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id, title: '第一会话', workspaceId: 'ws_1' })
  }, 60_000)

  it('会话选项跨重开仍在；同一 requestId 幂等', async () => {
    const first = await open()
    sessions = first.instance
    first.faux.setResponses([fauxAssistantMessage([fauxText('收到')])])

    const created = await sessions.create({ model: { provider: 'faux', modelId: MODEL } })
    const id = created.id
    const submission = await sessions.submit(id, '你好', 'idem-1')
    await sessions.configure(id, { thinkingLevel: 'high', instructions: '只读，别改文件。' })
    await sessions.close()
    sessions = null

    const second = await open()
    sessions = second.instance
    second.faux.setResponses([fauxAssistantMessage([fauxText('收到')])])

    // 配置持久化
    const agent = await sessions.agentConfig(id)
    expect(agent.thinkingLevel).toBe('high')
    expect(String(agent.instructions ?? '')).toContain('只读')

    // 幂等：同一 requestId 返回同一 submission
    const again = await sessions.submit(id, '你好', 'idem-1')
    expect(again.id).toBe(submission.id)

    // 索引仍在
    expect((await sessions.list())[0].id).toBe(id)
  }, 60_000)

  it('索引能力：submit 递增消息数、rename 改标题、search 命中文本', async () => {
    const opened = await open()
    sessions = opened.instance
    opened.faux.setResponses([fauxAssistantMessage([fauxText('部署已经完成')])])

    const created = await sessions.create({ title: '第一会话', model: { provider: 'faux', modelId: MODEL } })
    await sessions.submit(created.id, '帮我看看部署进度', 'm-1')

    // 提交后消息数递增（pi 不记这个数，视图索引维护）
    expect((await sessions.list())[0].messageCount).toBe(1)

    // 重命名写视图索引
    await sessions.rename(created.id, '改名了')
    expect((await sessions.list())[0].title).toBe('改名了')

    // 搜索扫 entries 文本，命中返回片段
    const hits = await sessions.search('部署')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ sessionId: created.id, title: '改名了' })
    expect(hits[0].snippet).toContain('部署')

    expect(await sessions.search('不存在的词')).toEqual([])
  }, 60_000)

  it('索引丢失不影响会话（真相在 durable）', async () => {
    const first = await open()
    sessions = first.instance
    first.faux.setResponses([fauxAssistantMessage([fauxText('收到')])])
    const created = await sessions.create({ model: { provider: 'faux', modelId: MODEL } })
    const id = created.id
    await sessions.submit(id, '你好', 'lost-1')
    await sessions.close()
    sessions = null

    // 破坏索引后再打开：列表为空，但会话本身仍可打开与读视图
    await writeFile(indexFile, '{ 这不是 JSON', 'utf8')
    const second = await open()
    sessions = second.instance
    expect(await sessions.list()).toEqual([])
    const view = await sessions.view(id)
    expect(view.entries).toBeDefined()
  }, 60_000)

  it('按工作空间过滤列表', async () => {
    const a = await open('ws_a')
    await a.instance.create({ model: { provider: 'faux', modelId: MODEL }, title: 'A 的会话' })
    expect((await a.instance.list()).map((entry) => entry.title)).toEqual(['A 的会话'])
    await a.instance.close() // 同一 SQLite 文件不能同时被两个实例持有

    const b = await open('ws_b')
    sessions = b.instance
    expect(await sessions.list()).toEqual([])
  }, 60_000)
})
