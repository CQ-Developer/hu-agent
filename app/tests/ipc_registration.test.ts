/**
 * 架构约束测试：IPC handler 只能在 main/ipc 注册，channel 不重复且清单稳定。
 *
 * 背景：index.ts 与 ipc.ts 曾同时注册 app:get-version，导致应用启动即抛
 * "Attempted to register a second handler"。P2 把 ipc.ts 拆成 `ipc/*` 各域模块后，
 * 本测试改为扫描入口 + 目录，并用「拆分前抓取的金标清单」防止拆分漏注册/多注册。
 */

import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const IPC_ENTRY = new URL('../src/main/ipc.ts', import.meta.url)
const IPC_DIR = new URL('../src/main/ipc/', import.meta.url)

/** 拆分前的完整 channel 清单（characterization）：拆分后必须一字不差。 */
const EXPECTED_CHANNELS = [
  'agent:answer-guide',
  'agent:cancel',
  'agent:decide-approval',
  'agent:send',
  'app:get-version',
  'cloud:clear-queue',
  'cloud:delete-account',
  'cloud:devices',
  'cloud:export-data',
  'cloud:flush',
  'cloud:login',
  'cloud:logout',
  'cloud:providers',
  'cloud:register',
  'cloud:revoke-device',
  'cloud:session',
  'cloud:sso-login',
  'cloud:status',
  'cloud:update-locale',
  'diagnostics:export',
  'market:check-status',
  'market:detail',
  'market:install',
  'market:installed',
  'market:list',
  'market:mcp-detail',
  'market:mcp-install',
  'market:mcp-list',
  'market:mcp-uninstall',
  'market:uninstall',
  'mcp:list',
  'mcp:remove',
  'mcp:save',
  'mcp:set-enabled',
  'mcp:test',
  'permissions:audit',
  'permissions:rules',
  'sessions:create',
  'sessions:items',
  'sessions:list',
  'sessions:options',
  'sessions:rename',
  'sessions:search',
  'sessions:set-options',
  'sessions:stats',
  'settings:get',
  'settings:get-locale',
  'settings:remove-provider',
  'settings:save-provider',
  'settings:set-default',
  'settings:set-locale',
  'skills:list',
  'skills:set-enabled',
  'stats:activations',
  'stats:orgs',
  'stats:teams',
  'stats:usage',
  'sync:get-settings',
  'sync:now',
  'sync:pin',
  'sync:remove',
  'sync:resolve',
  'sync:restore',
  'sync:set-settings',
  'sync:status',
  'sync:versions',
  'usage:stats',
  'workspace:active',
  'workspace:list',
  'workspace:pick',
  'workspace:set-active',
]

function channelsOf(source: string): string[] {
  return [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((match) => match[1])
}

/** 入口 + ipc/ 目录下全部源码（拆分后 handler 在目录里）。 */
async function readIpcSources(): Promise<string[]> {
  const sources = [await readFile(IPC_ENTRY, 'utf8')]
  if (existsSync(IPC_DIR)) {
    for (const name of (await readdir(IPC_DIR)).sort()) {
      if (name.endsWith('.ts')) sources.push(await readFile(new URL(name, IPC_DIR), 'utf8'))
    }
  }
  return sources
}

describe('IPC 注册纪律', () => {
  it('main/index.ts 不直接注册 ipcMain handler', async () => {
    const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('ipcMain.handle')
  })

  it('channel 清单与拆分前一致（金标）且不重复', async () => {
    const sources = await readIpcSources()
    const channels = sources.flatMap(channelsOf)
    expect([...channels].sort()).toEqual(EXPECTED_CHANNELS)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('preload 暴露的每个 channel 都有对应注册', async () => {
    const [preload, sources] = await Promise.all([
      readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
      readIpcSources(),
    ])
    const registered = new Set(sources.flatMap(channelsOf))
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1])
    expect(invoked.length).toBeGreaterThan(0)
    for (const channel of invoked) {
      expect(registered, `缺少 IPC 注册：${channel}`).toContain(channel)
    }
  })
})
