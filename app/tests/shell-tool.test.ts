/** shell 工具加固单测：超时终止与正常执行。 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { InteractionBroker } from '../src/main/permissions/broker'
import type { ArtifactStore } from '../src/main/session/artifacts'
import { bashTool } from '../src/main/tools/shell'
import type { ToolContext } from '../src/main/tools/types'

describe('bash 工具', () => {
  let root: string

  function context(signal = new AbortController().signal): ToolContext {
    return {
      workspaceRoot: root,
      sessionId: 's1',
      turnId: 't1',
      signal,
      artifacts: {} as ArtifactStore,
      interactions: {} as InteractionBroker,
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'huagent-shell-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('正常执行返回输出与退出码', async () => {
    const result = await bashTool.run({ command: 'echo hello-shell' }, context())
    expect(result.status).toBe('ok')
    expect(result.output).toContain('hello-shell')
    expect(result.output).toContain('[exit 0]')
  })

  it('超时后终止并返回 timeout', async () => {
    const started = Date.now()
    const result = await bashTool.run({ command: 'sleep 30', timeout_ms: 1000 }, context())
    const elapsed = Date.now() - started
    expect(result.status).toBe('timeout')
    expect(elapsed).toBeLessThan(10_000)
  }, 20_000)

  it('取消信号终止命令', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const result = await bashTool.run({ command: 'sleep 30' }, context(controller.signal))
    expect(result.status).toBe('timeout')
    expect(result.output).toContain('取消')
  }, 20_000)

  it('非零退出码按 error 返回', async () => {
    const result = await bashTool.run({ command: 'exit 3' }, context())
    expect(result.status).toBe('error')
    expect(result.output).toContain('[exit 3]')
  })
})
