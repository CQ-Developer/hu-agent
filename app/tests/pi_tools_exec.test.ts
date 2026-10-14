/**
 * pi 原生工具测试（R2）：bash / powershell / ask_guide。
 *
 * 重点覆盖"换引擎不能丢"的加固语义：超时终止、取消终止、非零退出码、输出格式；
 * 以及交互工具的三种结局（有选择 / 用户取消 / 参数非法）。
 */

import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { InteractionBroker } from '../src/main/permissions/broker'
import { createAskGuideTool } from '../src/main/tools/native/ask_guide'
import { createBashTool, createPowerShellTool } from '../src/main/tools/native/shell'
import { ToolFailure } from '../src/main/tools/native/tool'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'huagent-exec-'))
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content[0]?.text ?? ''
}

describe('bash / powershell', () => {
  it('成功命令：带回显、stdout 与退出码', async () => {
    const root = await workspace()
    const bash = createBashTool({ workspaceRoot: root })
    const result = await bash.execute('c1', { command: 'echo hu-agent' }, undefined as never, undefined)

    expect(firstText(result)).toContain('$ echo hu-agent')
    expect(firstText(result)).toContain('hu-agent')
    expect(firstText(result)).toContain('[exit 0]')
    expect(result.details).toMatchObject({ exitCode: 0 })
  })

  it('非零退出码抛错，但输出里保留 stderr 与真实退出码（模型可据此自我修正）', async () => {
    const root = await workspace()
    const bash = createBashTool({ workspaceRoot: root })

    await expect(
      bash.execute('c1', { command: 'echo oops 1>&2; exit 3' }, undefined as never, undefined),
    ).rejects.toThrow(/\[stderr\][\s\S]*oops[\s\S]*\[exit 3\]/)
  })

  it('cwd 相对工作空间解析，越界被拒绝', async () => {
    const root = await workspace()
    await mkdir(join(root, 'sub'), { recursive: true })
    const bash = createBashTool({ workspaceRoot: root })

    const result = await bash.execute('c1', { command: 'pwd', cwd: 'sub' }, undefined as never, undefined)
    expect(firstText(result)).toContain('sub')

    await expect(
      bash.execute('c2', { command: 'pwd', cwd: '../..' }, undefined as never, undefined),
    ).rejects.toThrow()
  })

  it('超时：终止命令并以 timeout 语义抛错', async () => {
    const root = await workspace()
    const bash = createBashTool({ workspaceRoot: root })
    const started = Date.now()

    await expect(
      bash.execute('c1', { command: 'sleep 10', timeout_ms: 1000 }, undefined as never, undefined),
    ).rejects.toMatchObject({ status: 'timeout' })
    expect(Date.now() - started).toBeLessThan(8_000) // 没有等满 sleep
  }, 15_000)

  it('取消：signal 触发后终止命令', async () => {
    const root = await workspace()
    const bash = createBashTool({ workspaceRoot: root })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    await expect(
      bash.execute('c1', { command: 'sleep 10' }, controller.signal as never, undefined),
    ).rejects.toThrow(/已取消/)
  }, 15_000)

  it('powershell 工具存在且参数合法（未安装时不报类型错误）', async () => {
    const root = await workspace()
    const powershell = createPowerShellTool({ workspaceRoot: root })
    expect(powershell.name).toBe('powershell')
    expect(powershell.category).toBe('exec')

    await powershell
      .execute('c1', { command: 'Write-Output hi' }, undefined as never, undefined)
      .then((result) => expect(firstText(result)).toContain('hi'))
      .catch((error: unknown) => {
        // 未安装 powershell 时应给出可读提示，而不是崩掉
        expect(error).toBeInstanceOf(ToolFailure)
        expect(String((error as Error).message)).toMatch(/未找到 powershell|命令启动失败/)
      })
  }, 30_000)
})

describe('ask_guide', () => {
  function broker(answer: string): InteractionBroker {
    return { askGuide: async () => answer } as unknown as InteractionBroker
  }

  it('拿到选择后回传用户选择', async () => {
    const root = await workspace()
    const tool = createAskGuideTool({
      workspaceRoot: root,
      interactions: broker('deploy'),
      sessionId: 's1',
      turnId: 't1',
    })

    const result = await tool.execute(
      'c1',
      { question: '怎么发布？', options: [{ label: '直接发布', value: 'deploy' }] },
      undefined as never,
      undefined,
    )
    expect(firstText(result)).toBe('用户选择：deploy')
    expect(result.details).toMatchObject({ answer: 'deploy' })
  })

  it('用户取消：抛 denied（不是技术错误）', async () => {
    const root = await workspace()
    const tool = createAskGuideTool({
      workspaceRoot: root,
      interactions: broker(''),
      sessionId: 's1',
      turnId: 't1',
    })

    await expect(
      tool.execute('c1', { question: '继续吗', options: [{ label: '是', value: 'yes' }] }, undefined as never, undefined),
    ).rejects.toMatchObject({ status: 'denied' })
  })

  it('参数非法（没有选项）直接抛错', async () => {
    const root = await workspace()
    const tool = createAskGuideTool({
      workspaceRoot: root,
      interactions: broker('x'),
      sessionId: 's1',
      turnId: 't1',
    })

    await expect(
      tool.execute('c1', { question: '空选项', options: [] }, undefined as never, undefined),
    ).rejects.toThrow(/至少一个 option/)
  })

  it('选项最多 6 个（超出被截断，防止界面被撑爆）', async () => {
    const root = await workspace()
    let received = 0
    const tool = createAskGuideTool({
      workspaceRoot: root,
      interactions: {
        askGuide: async (request: { options: unknown[] }) => {
          received = request.options.length
          return 'v0'
        },
      } as unknown as InteractionBroker,
      sessionId: 's1',
      turnId: 't1',
    })

    const options = Array.from({ length: 10 }, (_value, index) => ({ label: `选项${index}`, value: `v${index}` }))
    await tool.execute('c1', { question: '选一个', options }, undefined as never, undefined)
    expect(received).toBe(6)
  })
})
