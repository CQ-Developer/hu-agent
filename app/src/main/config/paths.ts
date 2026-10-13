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

/** 工作空间与云账户路径（design 4.1/5.10）。 */
export function cloudConfigFile(): string {
  return join(globalDir(), 'cloud.json')
}

/** 多工作空间索引（design 5.6）：列表与当前激活项 */
export function workspacesIndexFile(): string {
  return join(globalDir(), 'workspaces.json')
}
