/** 日志滚动与诊断包脱敏单测（design 9.4）。 */

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { redactObject, truncatePaths } from '../src/main/diagnostics'
import { FileLogger } from '../src/main/logging'

describe('诊断包脱敏', () => {
  it('掩码敏感字段（含嵌套与数组），保留普通字段', () => {
    const redacted = redactObject({
      serverUrl: 'https://hu-agent.example.com',
      email: 'user@example.com',
      apiKey: 'sk-123',
      refreshToken: 'r-1',
      nested: { password: 'p', region: 'cn' },
      providers: [{ id: 'openai', apiKeyRef: 'provider.openai', models: ['gpt-4o'] }],
    })
    expect(redacted.serverUrl).toBe('https://hu-agent.example.com')
    expect(redacted.email).toBe('user@example.com')
    expect(redacted.apiKey).toBe('***')
    expect(redacted.refreshToken).toBe('***')
    expect(redacted.nested).toEqual({ password: '***', region: 'cn' })
    expect(redacted.providers).toEqual([{ id: 'openai', apiKeyRef: '***', models: ['gpt-4o'] }])
  })

  it('把用户主目录替换为 ~', () => {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
    if (!home) return
    const path = `${home}\\hu-agent\\logs\\app.log`
    expect(truncatePaths(path)).toContain('~')
    expect(truncatePaths(path)).not.toContain(home)
  })
})

describe('FileLogger', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-logger-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('写入带时间戳与级别的日志', async () => {
    const file = join(dir, 'app.log')
    const logger = new FileLogger({ file, maxBytes: 10 * 1024, keepFiles: 3 })
    logger.append('INFO', 'hello world')
    logger.append('ERROR', 'boom')
    logger.close()
    const content = await readFile(file, 'utf8')
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T.* INFO {2}hello world$/m)
    expect(content).toContain('ERROR boom')
  })

  it('超过大小后滚动并保留指定份数', async () => {
    const file = join(dir, 'app.log')
    const logger = new FileLogger({ file, maxBytes: 200, keepFiles: 2, sizeCheckIntervalMs: 0 })
    for (let index = 0; index < 40; index += 1) logger.append('INFO', `line-${index}-${'x'.repeat(20)}`)
    logger.close()

    const files = (await readdir(dir)).sort()
    expect(files).toContain('app.log')
    expect(files).toContain('app.log.1')
    expect(files).not.toContain('app.log.3')
    expect((await stat(file)).size).toBeLessThan(400)
  })

  it('超长内容截断，避免单条日志撑爆文件', async () => {
    const file = join(dir, 'app.log')
    const logger = new FileLogger({ file, maxBytes: 1024 * 1024, keepFiles: 1 })
    logger.append('INFO', 'y'.repeat(9000))
    logger.close()
    expect((await readFile(file, 'utf8')).length).toBeLessThan(8100)
  })
})
