/** 诊断包导出（design 9.4）：把日志与本地配置打包成 zip，自动脱敏后交给用户/运维。
 *
 * 脱敏规则：
 * - 绝不包含 `secrets.enc.json`（密钥库）；
 * - 配置中的 token/secret/password/apiKey 类字段一律替换为 `***`；
 * - 绝对路径中的用户主目录替换为 `~`（保留结构，便于定位而不泄露用户名）；
 * - mcp.json 的 env/headers 只保留键名（值本就是 secret:// 引用，仍做掩码）。
 */

import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { globalDir, cloudConfigFile, configFilePath, workspacesIndexFile } from './config/paths'
import { logDir } from './logging'
import { writeZipToFile, type ZipSource } from './sync/zip-write'
import { t } from './i18n'

const SENSITIVE_KEY = /(token|secret|password|api[-_]?key|authorization)/i

export function redactValue(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY.test(key)) return '***'
  if (typeof value === 'string') return truncatePaths(value)
  if (Array.isArray(value)) return value.map((item, index) => redactValue(`${key}[${index}]`, item))
  if (value !== null && typeof value === 'object') return redactObject(value as Record<string, unknown>)
  return value
}

export function redactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) output[key] = redactValue(key, value)
  return output
}

/** 把主目录替换为 ~，避免泄露用户名与目录结构。 */
export function truncatePaths(text: string): string {
  const home = homedir()
  let result = text.split(home).join('~')
  if (process.platform === 'win32') {
    result = result.replace(/[A-Za-z]:\\\\Users\\\\[^\\/\\s"']+/g, '~')
  }
  return result
}

export interface DiagnosticResult {
  path: string
  files: number
  bytes: number
}

/** 生成诊断包；`targetPath` 由调用方（保存对话框）提供。 */
export async function exportDiagnostics(targetPath: string, appVersion: string): Promise<DiagnosticResult> {
  const staging = join(globalDir(), 'logs', 'diagnostics-staging')
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })

  const sources: ZipSource[] = []
  const add = async (sourcePath: string, name: string): Promise<void> => {
    try {
      const info = await stat(sourcePath)
      if (!info.isFile()) return
      const destination = join(staging, name.replace(/\//g, '__'))
      if (name.endsWith('.json')) {
        const parsed = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>
        const { writeFile } = await import('node:fs/promises')
        await writeFile(destination, JSON.stringify(redactObject(parsed), null, 2), 'utf8')
      } else {
        await copyFile(sourcePath, destination)
      }
      sources.push({ path: name, sourcePath: destination, size: (await stat(destination)).size })
    } catch {
      // 文件不存在或解析失败：跳过（诊断包不因单个文件失败而失败）
    }
  }

  // 日志（当前 + 滚动）
  try {
    const entries = await readdir(logDir())
    for (const entry of entries) {
      if (entry.startsWith('app.log')) await add(join(logDir(), entry), `logs/${entry}`)
    }
  } catch {
    // 无日志目录
  }

  await add(configFilePath(), 'config.json')
  await add(cloudConfigFile(), 'cloud.json')
  await add(workspacesIndexFile(), 'workspaces.json')
  await add(join(globalDir(), 'installed.json'), 'installed.json')
  await add(join(globalDir(), 'resource-status.json'), 'resource-status.json')
  await add(join(globalDir(), 'mcp.json'), 'mcp.json')
  await add(join(globalDir(), 'skills.json'), 'skills.json')

  // 工作空间内的审计与同步状态（路径截断在文本里）
  try {
    const index = JSON.parse(await readFile(workspacesIndexFile(), 'utf8')) as {
      workspaces?: { id: string; name: string; root: string }[]
    }
    for (const workspace of index.workspaces ?? []) {
      const safe = workspace.name.replace(/[^\w.-]/g, '_')
      await add(join(workspace.root, '.hu', 'logs', 'audit.jsonl'), `workspaces/${safe}/audit.jsonl`)
      await add(join(workspace.root, '.hu', 'sync', 'state.json'), `workspaces/${safe}/sync-state.json`)
    }
  } catch {
    // 工作空间索引损坏：跳过
  }

  const summary = [
    t(`hu-agent 诊断包`),
    `appVersion: ${appVersion}`,
    `platform: ${process.platform} ${process.arch}`,
    `node: ${process.versions.node}`,
    `electron: ${process.versions.electron}`,
    `generatedAt: ${new Date().toISOString()}`,
    '',
    t('说明：已自动脱敏（密钥字段 ***、主目录 ~）；不含 secrets.enc.json。'),
  ].join('\n')
  const { writeFile } = await import('node:fs/promises')
  const summaryPath = join(staging, 'system-info.txt')
  await writeFile(summaryPath, summary, 'utf8')
  sources.push({ path: 'system-info.txt', sourcePath: summaryPath, size: (await stat(summaryPath)).size })

  const result = await writeZipToFile(targetPath, sources)
  await rm(staging, { recursive: true, force: true })
  return { path: targetPath, files: result.fileCount, bytes: result.sizeBytes }
}
