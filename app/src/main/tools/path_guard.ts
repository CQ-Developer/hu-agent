/** 工作空间路径约束（design 5.5.4 的基础版本）。
 *
 * 阶段 2 会替换为完整权限引擎（realpath、符号链接、Windows 保留名、审批卡片）。
 */

import { isAbsolute, relative, resolve } from 'node:path'

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolInputError'
  }
}

export function resolveInWorkspace(root: string, input: string): string {
  if (!input || typeof input !== 'string') throw new ToolInputError('path 不能为空')
  const target = isAbsolute(input) ? resolve(input) : resolve(root, input)
  const rel = relative(root, target)
  if (rel === '') return target
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ToolInputError(`路径越过工作空间：${input}`)
  }
  return target
}
