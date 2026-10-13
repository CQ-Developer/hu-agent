/** 全局路径约定（design 5.1/5.9）：~/.hu-agent 下的配置与默认工作空间。 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export function globalDir(): string {
  return join(homedir(), '.hu-agent')
}

export function configFilePath(): string {
  return join(globalDir(), 'config.json')
}

export function secretsFilePath(): string {
  return join(globalDir(), 'secrets.enc.json')
}

export function usageLedgerPath(): string {
  return join(globalDir(), 'usage', 'ledger.jsonl')
}

/** 阶段 1 的隐式默认工作空间；阶段 2 支持用户选择目录 */
export function defaultWorkspaceDir(): string {
  return join(globalDir(), 'workspaces', 'default')
}
