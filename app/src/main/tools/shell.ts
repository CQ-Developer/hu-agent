/** bash / powershell：执行命令行。
 *
 * 加固点（design 2-04）：
 * - 超时/取消时终止整个进程树（Windows 用 taskkill /T，POSIX 用进程组信号）
 * - 输出按流限量，超出后标注截断（模型侧还有统一截断 + artifact）
 * - UTF-8 解码失败以替换字符呈现，不因编码中断执行
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { resolveInWorkspace } from './path-guard'
import { defineTool, type AnyTool, type ToolResult } from './types'

const MAX_STREAM_BYTES = 1024 * 1024

interface Input {
  command: string
  cwd?: string
  timeout_ms?: number
  description?: string
}

export function terminateTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function appendChunk(buffer: { text: string; truncated: boolean }, chunk: Buffer): void {
  if (buffer.text.length >= MAX_STREAM_BYTES) {
    buffer.truncated = true
    return
  }
  buffer.text += chunk.toString('utf8')
}

function runCommand(file: string, args: (command: string) => string[], shellName: string): AnyTool {
  return defineTool<Input>({
    name: shellName,
    category: 'exec',
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
          // POSIX 下独立进程组，便于整组终止；Windows 用 taskkill /T
          detached: process.platform !== 'win32',
          env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
        })

        const stdout = { text: '', truncated: false }
        const stderr = { text: '', truncated: false }
        let settled = false
        const finish = (result: ToolResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          ctx.signal.removeEventListener('abort', onAbort)
          resolveResult(result)
        }

        const timer = setTimeout(() => {
          terminateTree(child)
          finish({ status: 'timeout', output: `命令超时（${timeout}ms）已终止：${input.command}` })
        }, timeout)

        const onAbort = (): void => {
          terminateTree(child)
          finish({ status: 'timeout', output: '命令已取消' })
        }
        ctx.signal.addEventListener('abort', onAbort, { once: true })

        child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdout, chunk))
        child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderr, chunk))

        child.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') {
            finish({
              status: 'error',
              output:
                shellName === 'bash'
                  ? '未找到 bash：Windows 可安装 Git Bash，或改用 powershell 工具。'
                  : '未找到 powershell 可执行文件。',
            })
          } else {
            finish({ status: 'error', output: `命令启动失败：${error.message}` })
          }
        })

        child.on('close', (code) => {
          const parts = [`$ ${input.command}`]
          if (stdout.text.trim()) parts.push(stdout.text.trimEnd())
          if (stderr.text.trim()) parts.push(`[stderr]\n${stderr.text.trimEnd()}`)
          if (stdout.truncated || stderr.truncated) parts.push('[输出超过 1MB，已截断]')
          parts.push(`[exit ${code ?? -1}]`)
          finish({
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
