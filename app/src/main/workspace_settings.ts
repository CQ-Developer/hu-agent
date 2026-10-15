/** 工作空间策略文件（<ws>/.hu/settings.json）与全局策略读取（design 5.5.2）。 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { PolicyRule } from './permissions/types'

export interface WorkspaceSettingsFile {
  permissions?: { rules?: PolicyRule[] }
  [key: string]: unknown
}

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null // 缺失或损坏：按未配置处理
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2), 'utf8')
  await rename(temp, file)
}

export async function loadWorkspaceRules(file: string): Promise<PolicyRule[]> {
  const data = (await readJson(file)) as WorkspaceSettingsFile | null
  const rules = data?.permissions?.rules
  return Array.isArray(rules) ? rules : []
}

/** 追加“始终允许”规则（去重）。 */
export async function appendWorkspaceRule(file: string, rule: PolicyRule): Promise<void> {
  const data = ((await readJson(file)) as WorkspaceSettingsFile | null) ?? {}
  const permissions = data.permissions ?? {}
  const rules = Array.isArray(permissions.rules) ? permissions.rules : []
  const key = JSON.stringify(rule)
  if (!rules.some((existing) => JSON.stringify(existing) === key)) {
    rules.unshift(rule)
  }
  data.permissions = { ...permissions, rules }
  await writeJson(file, data)
}

/** 全局策略读取：~/.hu-agent/config.json 的 permissions.rules（可选）。 */
export async function loadGlobalRules(configFile: string): Promise<PolicyRule[]> {
  const data = (await readJson(configFile)) as WorkspaceSettingsFile | null
  const rules = data?.permissions?.rules
  return Array.isArray(rules) ? rules : []
}
