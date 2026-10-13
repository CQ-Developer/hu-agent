/** 桌面端 SSO 流程单测（design 6.12.3）：PKCE、回环回调、state 校验、超时与错误回调。 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CloudClient } from '../src/main/cloud/client'
import { CloudStore } from '../src/main/cloud/store'
import { LoopbackServer, SsoLoginFlow, buildAuthorizeUrl, newPkcePair } from '../src/main/cloud/sso'

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
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const SERVER = 'http://127.0.0.1:8080'

describe('PKCE 与 authorize URL', () => {
  it('S256 challenge 与 verifier 匹配且不可逆', () => {
    const { verifier, challenge } = newPkcePair()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    expect(challenge).not.toContain('=')
    const expected = require('node:crypto')
      .createHash('sha256')
      .update(verifier)
      .digest('base64url') as string
    expect(challenge).toBe(expected)
    expect(challenge).not.toBe(verifier)
  })

  it('authorize URL 包含必要参数', () => {
    const url = new URL(
      buildAuthorizeUrl(SERVER, 'provider-1', {
        redirectUri: 'http://127.0.0.1:1234/callback',
        state: 'st-1',
        challenge: 'ch-1',
        deviceId: 'dev-1',
        appVersion: '0.1.0',
      }),
    )
    expect(url.pathname).toBe('/api/v1/auth/sso/provider-1/authorize')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:1234/callback')
    expect(url.searchParams.get('deviceId')).toBe('dev-1')
  })
})

describe('LoopbackServer', () => {
  it('启动后可接收 /callback 查询参数并返回页面', async () => {
    const server = new LoopbackServer()
    const redirectUri = await server.start()
    const received: Record<string, string>[] = []
    server.onCallback = (params) => received.push(params)
    try {
      const response = await fetch(`${redirectUri}?code=abc&state=st-1`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('登录完成')
      expect(received).toEqual([{ code: 'abc', state: 'st-1' }])
      const notFound = await fetch(redirectUri.replace('/callback', '/other'))
      expect(notFound.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})

describe('SsoLoginFlow', () => {
  let dir: string
  let secrets: FakeSecrets
  let client: CloudClient
  let fetchMock: ReturnType<typeof vi.fn>
  let nativeFetch: typeof fetch

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huagent-sso-'))
    secrets = new FakeSecrets()
    client = new CloudClient(secrets, new CloudStore(join(dir, 'cloud.json')), '0.1.0')
    nativeFetch = globalThis.fetch.bind(globalThis)
    fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      // 只拦截服务端 API；回环回调走真实 fetch
      if (!url.includes('/api/v1/')) return nativeFetch(input as RequestInfo, init)
      if (url.endsWith('/api/v1/auth/sso/exchange')) {
        return json({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresIn: 900,
          user: {
            id: 'u-sso',
            email: 'sso@example.com',
            displayName: 'SSO 用户',
            locale: 'zh-CN',
            isSystemAdmin: false,
          },
        })
      }
      return json({ code: 'NOT_FOUND', message: `unexpected ${url}` }, 404)
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true, force: true })
  })

  function flowWithBrowser(options: { timeoutMs?: number } = {}): SsoLoginFlow {
    return new SsoLoginFlow(client, {
      timeoutMs: options.timeoutMs ?? 5_000,
      openBrowser: async (authorizeUrl) => {
        const url = new URL(authorizeUrl)
        const redirectUri = url.searchParams.get('redirect_uri')!
        const state = url.searchParams.get('state')!
        await fetch(`${redirectUri}?code=one-time-code&state=${state}`)
      },
    })
  }

  it('完成 SSO 登录并持久化会话', async () => {
    const user = await flowWithBrowser().login(SERVER, 'provider-1')
    expect(user.email).toBe('sso@example.com')
    expect(await client.isLoggedIn()).toBe(true)
    expect(secrets.get('cloud.refreshToken')).toBe('refresh-1')
    const config = await client.config()
    expect(config.serverUrl).toBe(SERVER)
    expect(config.userId).toBe('u-sso')

    // 交换请求带 PKCE verifier，且与 authorize 的 challenge 对应
    const exchangeCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).endsWith('/api/v1/auth/sso/exchange'),
    )!
    const body = JSON.parse(String((exchangeCall[1] as RequestInit).body)) as Record<string, string>
    expect(body.code).toBe('one-time-code')
    expect(body.codeVerifier.length).toBeGreaterThanOrEqual(43)
  })

  it('浏览器返回 error 时抛出可读错误', async () => {
    const flow = new SsoLoginFlow(client, {
      openBrowser: async (authorizeUrl) => {
        const url = new URL(authorizeUrl)
        const redirectUri = url.searchParams.get('redirect_uri')!
        const state = url.searchParams.get('state')!
        await fetch(`${redirectUri}?error=access_denied&error_description=${encodeURIComponent('用户拒绝授权')}&state=${state}`)
      },
    })
    await expect(flow.login(SERVER, 'provider-1')).rejects.toThrow('用户拒绝授权')
  })

  it('state 不匹配的回调被忽略，匹配后才完成', async () => {
    const flow = new SsoLoginFlow(client, {
      openBrowser: async (authorizeUrl) => {
        const url = new URL(authorizeUrl)
        const redirectUri = url.searchParams.get('redirect_uri')!
        const state = url.searchParams.get('state')!
        await fetch(`${redirectUri}?code=evil&state=wrong-state`)
        await fetch(`${redirectUri}?code=one-time-code&state=${state}`)
      },
    })
    const user = await flow.login(SERVER, 'provider-1')
    expect(user.id).toBe('u-sso')
    const body = JSON.parse(
      String((fetchMock.mock.calls.find((call) => String(call[0]).endsWith('/exchange'))![1] as RequestInit).body),
    ) as Record<string, string>
    expect(body.code).toBe('one-time-code')
  })

  it('超时未收到回调时报错', async () => {
    const flow = new SsoLoginFlow(client, { timeoutMs: 150, openBrowser: async () => undefined })
    await expect(flow.login(SERVER, 'provider-1')).rejects.toThrow(/超时/)
  })

  it('未配置浏览器打开方式时报错（避免静默挂起）', async () => {
    const flow = new SsoLoginFlow(client, {})
    await expect(flow.login(SERVER, 'provider-1')).rejects.toThrow(/浏览器/)
  })
})
