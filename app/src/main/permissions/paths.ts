/** 路径沙箱：规范化 + 越界判定 + 敏感/保护路径（design 5.5.4/5.5.5）。 */

import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

import { PermissionPathError } from './types'
import { t } from '../i18n'

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const UNC_OR_DEVICE = /^[\\/]{2}/

/** 敏感路径：任何工具访问都拒绝（design 5.5.2 内置硬规则） */
const SENSITIVE_PATTERNS = [
  '~/.ssh/**',
  '~/.aws/**',
  '**/Keychains/**',
  '~/.hu-agent/secrets.enc.json',
]

/** 保护文件：Agent 不可写入（防自我提权，design 5.5.5） */
const PROTECTED_WRITE_PATTERNS = [
  '<workspace>/.hu/settings.json',
  '<workspace>/.hu/mcp.json',
  '<workspace>/.hu/skills.json',
  '<workspace>/.hu/workspace.json',
  '<workspace>/.hu/sync/**',
  '<workspace>/.hu/logs/**',
  '<workspace>/.hu/backups/**',
  '~/.hu-agent/config.json',
  '~/.hu-agent/installed.json',
  '~/.hu-agent/workspaces.json',
  '~/.hu-agent/secrets.enc.json',
]

export interface CanonicalPath {
  absolute: string
  insideWorkspace: boolean
}

/** 展开 ~ 并拒绝明显非法的输入。 */
export function expandUser(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2))
  return input
}

function assertPathShape(input: string): void {
  if (!input || input.trim().length === 0) throw new PermissionPathError(t('路径不能为空'))
  if (process.platform === 'win32') {
    if (UNC_OR_DEVICE.test(input)) {
      throw new PermissionPathError(t('不支持 UNC 或设备路径：{input}', { input }))
    }
    for (const segment of input.split(/[\\/]+/)) {
      if (WINDOWS_RESERVED.test(segment)) {
        throw new PermissionPathError(t('Windows 保留设备名：{segment}', { segment }))
      }
    }
  }
}

/** 取 realpath；目标不存在时回溯到最近存在的祖先再拼接（防创建时的符号链接逃逸）。 */
async function realpathBestEffort(target: string): Promise<string> {
  let current = target
  const suffix: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return suffix.length > 0 ? join(real, ...suffix.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return target
      suffix.push(basename(current))
      current = parent
    }
  }
}

function comparable(path: string): string {
  let value = normalize(path)
  if (process.platform === 'darwin') value = value.normalize('NFC')
  return process.platform === 'win32' ? value.toLowerCase() : value
}

function isInside(root: string, target: string): boolean {
  const rootC = comparable(root)
  const targetC = comparable(target)
  if (targetC === rootC) return true
  return targetC.startsWith(rootC.endsWith(sep) ? rootC : `${rootC}${sep}`)
}

export async function canonicalizePath(input: string, workspaceRoot: string): Promise<CanonicalPath> {
  assertPathShape(input)
  const expanded = expandUser(input)
  const absolute = isAbsolute(expanded) ? normalize(expanded) : resolve(workspaceRoot, expanded)
  const real = await realpathBestEffort(absolute)
  return { absolute: real, insideWorkspace: isInside(workspaceRoot, real) }
}

/** glob 匹配：支持 ** 与 *（不跨路径分隔符）。 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '')
}

function matchesPattern(target: string, pattern: string, workspaceRoot: string): boolean {
  const expanded = expandUser(pattern).replace('<workspace>', workspaceRoot)
  const targetC = comparable(target)
  const patternC = process.platform === 'win32' ? normalize(expanded).toLowerCase() : normalize(expanded)
  if (targetC === patternC) return true
  return globToRegExp(patternC).test(targetC)
}

export function matchesAnyPattern(target: string, patterns: string[], workspaceRoot: string): boolean {
  return patterns.some((pattern) => matchesPattern(target, pattern, workspaceRoot))
}

export function isSensitivePath(target: string, workspaceRoot: string): boolean {
  return matchesAnyPattern(target, SENSITIVE_PATTERNS, workspaceRoot)
}

export function isProtectedWritePath(target: string, workspaceRoot: string): boolean {
  return matchesAnyPattern(target, PROTECTED_WRITE_PATTERNS, workspaceRoot)
}

export { SENSITIVE_PATTERNS, PROTECTED_WRITE_PATTERNS }
