/** 云账户客户端单测（design 4.1 / 8.1）：登录、令牌存储、401 自动刷新、登出。 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudClient, CloudError, REFRESH_TOKEN_KEY, normalizeServerUrl } from '../src/main/cloud/client'
import { CloudStore } from '../src/main/cloud/store'

class FakeSecrets {
  private readonly values = new Map<string, string>()
  get(key: string): string | null {
    return this.values.get(key) ?? null
  }
  has(key: string): boolean {
    return this.values.has(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key)
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('normalizeServerUrl', () => {
  it('去掉尾部斜杠并拒绝非 http(s)', () => {
    expect(normalizeServerUrl(' http://127.0.0.1:8080/ ')).toBe('http://127.0.0.1:8080')
    expect(normalizeServerUrl('ftp://example.com')).toBe('')
    expect(normalizeServerUrl('example.com')).toBe('')
  })
})

describe('CloudClient', () => {
  let dir: string
  let secrets: FakeSecrets
  let client: CloudClient
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-cloud-'))
    secrets = new FakeSecrets()
    client = new CloudClient(secrets, new CloudStore(join(dir, 'cloud.json')), '0.1.0')
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  it('登录：保存账号信息与刷新令牌，access 仅内存', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresIn: 900,
        user: { id: 'u1', email: 'a@b.com', displayName: '用户', locale: 'zh-CN', isSystemAdmin: false },
      }),
    )

    const user = await client.login('http://127.0.0.1:8080', 'a@b.com', 'password-123')
    expect(user.email).toBe('a@b.com')
    expect(secrets.get(REFRESH_TOKEN_KEY)).toBe('refresh-1')
    expect(await client.isLoggedIn()).toBe(true)

    const config = await client.config()
    expect(config).toMatchObject({ serverUrl: 'http://127.0.0.1:8080', userId: 'u1', email: 'a@b.com' })
    expect(config.deviceId).toMatch(/^[0-9a-f-]{36}$/)

    // 登录请求体带设备信息与密码
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({ email: 'a@b.com', password: 'password-123' })
    expect((body.device as Record<string, unknown>).deviceId).toBe(config.deviceId)
  })

  it('鉴权请求带 Bearer；401 时自动刷新一次并重试', async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresIn: 900,
          user: { id: 'u1', email: 'a@b.com', displayName: '用户', locale: 'zh-CN', isSystemAdmin: false },
        }),
      )
      .mockResolvedValueOnce(json({ code: 'UNAUTHENTICATED', message: '过期' }, 401))
      .mockResolvedValueOnce(json({ accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 900 }))
      .mockResolvedValueOnce(json({ id: 'u1', email: 'a@b.com', displayName: '用户', locale: 'zh-CN', isSystemAdmin: false }))

    await client.login('http://127.0.0.1:8080', 'a@b.com', 'password-123')
    const me = await client.me()
    expect(me.email).toBe('a@b.com')

    const urls = fetchMock.mock.calls.map((call) => String((call as [string])[0]))
    expect(urls[1]).toBe('http://127.0.0.1:8080/api/v1/me')
    expect(urls[2]).toBe('http://127.0.0.1:8080/api/v1/auth/refresh')
    expect(urls[3]).toBe('http://127.0.0.1:8080/api/v1/me')
    // 刷新令牌已旋转
    expect(secrets.get(REFRESH_TOKEN_KEY)).toBe('refresh-2')
    // 第二次请求使用了新 access token
    const retryInit = fetchMock.mock.calls[3]?.[1] as RequestInit
    expect((retryInit.headers as Record<string, string>).authorization).toBe('Bearer access-2')
  })

  it('登出：调用服务端并清除本地会话（保留服务器地址）', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        accessToken: 'a',
        refreshToken: 'r',
        expiresIn: 900,
        user: { id: 'u1', email: 'a@b.com', displayName: '用户', locale: 'zh-CN', isSystemAdmin: false },
      }),
    )
    await client.login('http://127.0.0.1:8080', 'a@b.com', 'password-123')

    fetchMock.mockResolvedValueOnce(json({ revoked: 1 }))
    await client.logout()

    expect(await client.isLoggedIn()).toBe(false)
    expect(secrets.get(REFRESH_TOKEN_KEY)).toBeNull()
    const config = await client.config()
    expect(config.userId).toBeUndefined()
    expect(config.serverUrl).toBe('http://127.0.0.1:8080')
  })

  it('注册：先注册再自动登录', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ id: 'u1', email: 'a@b.com', displayName: '用户' }, 201))
      .mockResolvedValueOnce(
        json({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresIn: 900,
          user: { id: 'u1', email: 'a@b.com', displayName: '用户', locale: 'zh-CN', isSystemAdmin: false },
        }),
      )

    const user = await client.register('http://127.0.0.1:8080', 'a@b.com', '用户', 'password-123')
    expect(user.id).toBe('u1')
    const urls = fetchMock.mock.calls.map((call) => String((call as [string])[0]))
    expect(urls).toEqual([
      'http://127.0.0.1:8080/api/v1/auth/register',
      'http://127.0.0.1:8080/api/v1/auth/login',
    ])
    expect(await client.isLoggedIn()).toBe(true)
  })

  it('未登录时请求抛 UNAUTHENTICATED', async () => {
    await expect(client.me()).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('服务器地址非法时登录直接报错', async () => {
    await expect(client.login('not-a-url', 'a@b.com', 'password-123')).rejects.toBeInstanceOf(CloudError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
