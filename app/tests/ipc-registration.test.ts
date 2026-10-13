/** 架构约束测试：IPC handler 只能在 main/ipc.ts 注册，且 channel 不重复。
 *
 * 背景：index.ts 与 ipc.ts 曾同时注册 app:get-version，导致应用启动即抛
 * "Attempted to register a second handler"。单测把这个约束固化下来。
 */

import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('IPC 注册纪律', () => {
  it('main/index.ts 不直接注册 ipcMain handler', async () => {
    const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('ipcMain.handle')
  })

  it('main/ipc.ts 中 channel 不重复', async () => {
    const source = await readFile(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
    const channels = [...source.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1])
    expect(channels.length).toBeGreaterThan(0)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('preload 暴露的每个 channel 都有对应注册', async () => {
    const [preload, ipc] = await Promise.all([
      readFile(new URL('../src/preload/index.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/main/ipc.ts', import.meta.url), 'utf8'),
    ])
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1])
    for (const channel of invoked) {
      expect(ipc, `缺少 IPC 注册：${channel}`).toContain(`'${channel}'`)
    }
  })
})
