/** bash / powershell：执行命令行（阶段 2 接入命令审批与进程组终止）。 */

import { spawn } from 'node:child_process'

import { resolveInWorkspace } from './path-guard'
import { defineTool, type AnyTool, type ToolResult } from './types'

const MAX_STREAM_BYTES = 1024 * 1024

interface Input {
  command: string
  cwd?: string
  timeout_ms?: number
  description?: string
}

function runCommand(file: string, args: (command: string) => string[], shellName: string): AnyTool {
  return defineTool<Input>({
    name: shellName,
    description: `执行 ${shellName} 命令。工作目录默认为工作空间根目录。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        cwd: { type: 'string', description: '工作目录（相对工作空间，默认工作空间根目录）' },
        timeout_ms: { type: 'integer', description: '超时毫秒数，默认 120000，最大 600000' },
        description: { type: 'string', description: '命令用途说明（便于审计）' },
      },
      required: ['command'],
    },
    async run(input, ctx): Promise<ToolResult> {
      const cwd = input.cwd ? resolveInWorkspace(ctx.workspaceRoot, input.cwd) : ctx.workspaceRoot
      const timeout = Math.min(Math.max(input.timeout_ms ?? 120_000, 1000), 600_000)

      return await new Promise<ToolResult>((resolveResult) => {
        const child = spawn(file, args(input.command), {
          cwd,
          windowsHide: true,
          env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
        })

        let stdout = ''
        let stderr = ''
        let settled = false
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            child.kill()
            resolveResult({ status: 'timeout', output: `命令超时（${timeout}ms）：${input.command}` })
          }
        }, timeout)

        const onAbort = (): void => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            child.kill()
            resolveResult({ status: 'timeout', output: '命令已取消' })
          }
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true })

        child.stdout.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_STREAM_BYTES) stdout += chunk.toString('utf8')
        })
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_STREAM_BYTES) stderr += chunk.toString('utf8')
        })

        child.on('error', (error: NodeJS.ErrnoException) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error.code === 'ENOENT') {
            resolveResult({
              status: 'error',
              output:
                shellName === 'bash'
                  ? '未找到 bash：Windows 可安装 Git Bash，或改用 powershell 工具。'
                  : '未找到 powershell 可执行文件。',
            })
          } else {
            resolveResult({ status: 'error', output: `命令启动失败：${error.message}` })
          }
        })

        child.on('close', (code) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          ctx.signal.removeEventListener('abort', onAbort)
          const parts = [`$ ${input.command}`]
          if (stdout.trim()) parts.push(stdout.trimEnd())
          if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`)
          parts.push(`[exit ${code ?? -1}]`)
          resolveResult({
            status: code === 0 ? 'ok' : 'error',
            output: parts.join('\n'),
            metadata: { exitCode: code ?? -1 },
          })
        })
      })
    },
  })
}

export const bashTool = runCommand('bash', (command) => ['-lc', command], 'bash')
export const powershellTool = runCommand(
  'powershell.exe',
  (command) => ['-NoProfile', '-NonInteractive', '-Command', command],
  'powershell',
)
