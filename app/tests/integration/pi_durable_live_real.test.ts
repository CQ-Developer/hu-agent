/**
 * pi-durable 运行期形状勘察（R1 收尾前最后一块事实）：捕捉 `pi.live` 在**运行中**的结构。
 *
 * 为什么必须做：settle 后 `pi.live` 为空（上一轮已实测），因此实时增量（流式文本/思考、进行中的
 * 工具调用与输出）只能靠**订阅**时读到的 `pi.live`。它的字段名必须先成为事实，否则界面投影只能靠猜。
 *
 * 门禁：`PI_E2E=1` + `PI_AGENT_DIR`；只用 `deepseek-v4.1-flash`。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { Harness, ToolTask, createRegistry, defineExtension, defineTool, hook } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { Type } from 'typebox'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const ALLOWED_MODEL = 'deepseek-v4.1-flash'
const PROVIDER = process.env.PI_GATEWAY_PROVIDER ?? 'token-hub'
const agentDir = process.env.PI_AGENT_DIR ?? ''
const enabled = process.env.PI_E2E === '1' && agentDir !== ''

describe.skipIf(!enabled)('pi-durable 运行期形状（真实模型）', () => {
  let dir: string
  let file: string
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | null = null

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-durable-live-'))
    file = join(dir, 'session.sqlite')
  })

  afterEach(async () => {
    await storage?.close(BACKGROUND_CONTEXT).catch(() => undefined)
    storage = null
    await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 }).catch(() => undefined)
  })

  it('订阅 viewState：打印 pi.live 在运行期的形状与增量', async () => {
    const echo = defineTool({
      name: 'echo',
      description: '回显给定文本',
      parameters: Type.Object({ text: Type.String({ description: '要回显的文本' }) }),
      execute: async (_id: string, params: { text?: string }) => ({
        content: [{ type: 'text', text: `echo:${params?.text}` }],
      }),
    })
    const Tools = defineExtension({ name: 'huagent.tools', tools: [echo] })
    const Guard = defineExtension({
      name: 'huagent.guard',
      hooks: [hook(ToolTask, { beforeTool: async () => undefined })],
    })

    const registry = createRegistry()
    registry.install(Tools)
    registry.install(Guard)

    const { listProviders, readModelsFile, buildPiProviders } = await import('../../src/main/model/pi_config')
    const { openAICompletionsApi } = await import('@earendil-works/pi-ai/api/openai-completions.lazy')
    const models = createModels()
    const configPath = join(agentDir, 'models.json')
    const configFile = await readModelsFile(configPath)
    for (const built of buildPiProviders(
      await listProviders(configPath, () => false),
      configFile,
      () => openAICompletionsApi(),
      () => null,
    )) {
      models.setProvider(built.provider as never)
    }

    storage = await openNodeSqliteStorage(file)
    const harness = await Harness.open(storage, { models, registry }, BACKGROUND_CONTEXT)
    const root = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: PROVIDER, modelId: ALLOWED_MODEL } },
    })
    await root.configure({ extensions: [Tools, Guard], tools: [echo], modelTools: [echo] }, BACKGROUND_CONTEXT)

    // 订阅：捕捉运行期的 live 形状（去重后打印前若干帧）
    const frames: string[] = []
    const view = await root.viewState(BACKGROUND_CONTEXT)
    const unsubscribe = view.subscribe((value: { docs?: Record<string, unknown> }) => {
      const live = value.docs?.['pi.live']
      const encoded = JSON.stringify(live ?? null)
      if (encoded && encoded !== 'null' && encoded !== '{}' && !frames.includes(encoded)) {
        frames.push(encoded)
      }
    })

    const submission = await root.submit(
      {
        type: 'input',
        content: '请调用 echo 工具，参数 text 为 "hi"，然后简短总结一句。',
        requestId: 'live-1',
      },
      BACKGROUND_CONTEXT,
    )
    await submission.wait(BACKGROUND_CONTEXT)
    unsubscribe()
    ;(view as unknown as { dispose?: () => void }).dispose?.()

    // 把捕捉到的帧写到固定路径（vitest 会吞 console 输出，写文件才能在同一条命令里看结果）
    const dump = join(tmpdir(), 'huagent-live-shapes.txt')
    await writeFile(
      dump,
      [`帧数 = ${frames.length}`, ...frames.map((frame, index) => `--- 帧 ${index + 1} ---\n${frame.slice(0, 1200)}`)].join('\n'),
      'utf8',
    )
    console.log('[live] dump =', dump, '帧数 =', frames.length)
    // 至少捕捉到运行期状态（否则说明订阅时机不对，需要改为先订阅再提交）
    expect(frames.length).toBeGreaterThan(0)
  }, 240_000)
})
