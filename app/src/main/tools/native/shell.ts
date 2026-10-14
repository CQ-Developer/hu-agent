/**
 * pi 原生工具（R2）：`bash` / `powershell`。
 *
 * 加固点（design 2-04，与旧实现一致，不能因换引擎而丢失）：
 * - 超时/取消时终止**整个进程树**（Windows 用 `taskkill /T`，POSIX 用进程组信号）；
 * - 每路输出限量 1MB，超出即标注截断（模型侧还有统一截断 + artifact）；
 * - UTF-8 解码失败以替换字符呈现，不因编码中断执行。
 *
 * 与旧实现的差别：取消信号用 pi 传给 `execute` 的 `signal`（不再从我们的上下文对象取），
 * 失败按 pi 约定抛错。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { Type } from 'typebox'

import { resolveInWorkspace } from '../path_guard'
import { ToolFailure, type NativeTool, type ToolFactoryOptions } from './tool'

const MAX_STREAM_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

interface ShellInput {
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

function runCommand(
  options: ToolFactoryOptions,
  file: string,
  args: (command: string) => string[],
  shellName: 'bash' | 'powershell',
): NativeTool {
  const notFound =
    shellName === 'bash'
      ? '未找到 bash：Windows 可安装 Git Bash，或改用 powershell 工具。'
      : '未找到 powershell 可执行文件。'

  return {
    name: shellName,
    label: shellName === 'bash' ? '执行 bash 命令' : '执行 PowerShell 命令',
    category: 'exec',
    description: `执行 ${shellName} 命令。工作目录默认为工作空间根目录。`,
    parameters: Type.Object({
      command: Type.String({ description: '要执行的命令' }),
      cwd: Type.Optional(Type.String({ description: '工作目录（相对工作空间，默认工作空间根目录）' })),
      timeout_ms: Type.Optional(Type.Integer({ description: '超时毫秒数，默认 120000，最大 600000' })),
      description: Type.Optional(Type.String({ description: '命令用途说明（便于审计）' })),
    }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as ShellInput
      const cwd = input.cwd ? resolveInWorkspace(options.workspaceRoot, input.cwd) : options.workspaceRoot
      const timeout = Math.min(Math.max(input.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS)

      return await new Promise<{ content: Array<{ type: 'text'; text: string }>; details: { exitCode: number } }>(
        (resolveResult, rejectResult) => {
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

          const cleanup = (): void => {
            clearTimeout(timer)
            signal?.removeEventListener('abort', onAbort)
          }
          const fail = (message: string, status: 'error' | 'timeout'): void => {
            if (settled) return
            settled = true
            cleanup()
            rejectResult(new ToolFailure(message, status))
          }

          const timer = setTimeout(() => {
            terminateTree(child)
            fail(`命令超时（${timeout}ms）已终止：${input.command}`, 'timeout')
          }, timeout)

          const onAbort = (): void => {
            terminateTree(child)
            fail('命令已取消', 'timeout')
          }
          signal?.addEventListener('abort', onAbort, { once: true })

          child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdout, chunk))
          child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderr, chunk))

          child.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') fail(notFound, 'error')
            else fail(`命令启动失败：${error.message}`, 'error')
          })

          child.on('close', (code) => {
            if (settled) return
            settled = true
            cleanup()

            const parts = [`$ ${input.command}`]
            if (stdout.text.trim()) parts.push(stdout.text.trimEnd())
            if (stderr.text.trim()) parts.push(`[stderr]\n${stderr.text.trimEnd()}`)
            if (stdout.truncated || stderr.truncated) parts.push('[输出超过 1MB，已截断]')
            parts.push(`[exit ${code ?? -1}]`)

            const output = parts.join('\n')
            const exitCode = code ?? -1
            if (exitCode !== 0) {
              rejectResult(new ToolFailure(output, 'error'))
              return
            }
            resolveResult({ content: [{ type: 'text' as const, text: output }], details: { exitCode } })
          })
        },
      )
    },
  }
}

export function createBashTool(options: ToolFactoryOptions): NativeTool {
  return runCommand(options, 'bash', (command) => ['-lc', command], 'bash')
}

export function createPowerShellTool(options: ToolFactoryOptions): NativeTool {
  return runCommand(
    options,
    'powershell.exe',
    (command) => ['-NoProfile', '-NonInteractive', '-Command', command],
    'powershell',
  )
}
