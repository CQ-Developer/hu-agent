/** 桌面端 SSO 登录（design 6.12.3）：系统浏览器 + 回环回调 + PKCE。
 *
 * 流程：GET /auth/providers → 启动 127.0.0.1 随机端口回环服务 → 打开 authorize →
 * 浏览器回调回环（一次性 code）→ POST /auth/sso/exchange（code + PKCE verifier）→ 本地会话。
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import type { CloudClient, CloudUser } from './client'
import { t } from '../i18n'

export interface SsoProviderView {
  id: string
  type: string
  name: string
  enabled: boolean
}

export interface SsoLoginOptions {
  /** 打开系统浏览器（默认由主进程注入 shell.openExternal） */
  openBrowser?: (url: string) => Promise<void>
  timeoutMs?: number
  /** 测试可注入固定 verifier */
  verifier?: string
}

const LOOPBACK_HOST = '127.0.0.1'
const DEFAULT_TIMEOUT_MS = 5 * 60_000

export function newPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 回环回调服务：只接受 /callback，校验 state 后返回 query。 */
export class LoopbackServer {
  private server: Server | null = null
  private port = 0

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('not found')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        t('<html><body style="font-family:sans-serif;padding:40px"><h3>登录完成</h3><p>请返回 hu-agent 应用。</p></body></html>'),
      )
      this.onCallback?.(Object.fromEntries(url.searchParams.entries()))
    })
    await new Promise<void>((resolve) => this.server!.listen(0, LOOPBACK_HOST, resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error(t('无法启动回环回调服务'))
    this.port = address.port
    return `http://${LOOPBACK_HOST}:${this.port}/callback`
  }

  onCallback: ((params: Record<string, string>) => void) | null = null

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export class SsoLoginFlow {
  constructor(
    private readonly cloud: CloudClient,
    private readonly options: SsoLoginOptions = {},
  ) {}

  async providers(serverUrl: string): Promise<SsoProviderView[]> {
    return this.cloud.listProviders(serverUrl)
  }

  /** 完成一次 SSO 登录并持久化本地会话。 */
  async login(serverUrl: string, providerId: string): Promise<CloudUser> {
    const pair = this.options.verifier
      ? { verifier: this.options.verifier, challenge: challengeOf(this.options.verifier) }
      : newPkcePair()
    const state = randomBytes(24).toString('base64url')
    const loopback = new LoopbackServer()
    const redirectUri = await loopback.start()

    const callbacks: Record<string, string>[] = []
    let resolveCallback: ((params: Record<string, string>) => void) | null = null
    loopback.onCallback = (params) => {
      if (params.state !== state) return // state 不匹配：忽略（保持等待）
      callbacks.push(params)
      resolveCallback?.(params)
    }

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const waitForCallback = new Promise<Record<string, string>>((resolve) => {
      resolveCallback = resolve
      if (callbacks.length > 0) resolve(callbacks[0]!)
    })

    try {
      const config = await this.cloud.config()
      const authorizeUrl = buildAuthorizeUrl(serverUrl, providerId, {
        redirectUri,
        state,
        challenge: pair.challenge,
        deviceId: config.deviceId,
        appVersion: this.cloud.appVersionValue(),
      })
      if (!this.options.openBrowser) throw new Error(t('未配置浏览器打开方式'))
      await this.options.openBrowser(authorizeUrl)

      const params = await Promise.race([
        waitForCallback,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(t('SSO 登录超时（未收到浏览器回调）'))), timeoutMs).unref?.(),
        ),
      ])
      if (params.error) {
        throw new Error(params.error_description ?? params.error)
      }
      if (!params.code) throw new Error(t('回调缺少一次性 code'))
      return await this.cloud.ssoExchange(serverUrl, params.code, pair.verifier)
    } finally {
      await loopback.close()
    }
  }
}

export function buildAuthorizeUrl(
  serverUrl: string,
  providerId: string,
  params: {
    redirectUri: string
    state: string
    challenge: string
    deviceId: string
    appVersion: string
  },
): string {
  const base = serverUrl.replace(/\/+$/, '')
  const query = new URLSearchParams({
    redirect_uri: params.redirectUri,
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    deviceId: params.deviceId,
    platform: currentPlatform(),
    appVersion: params.appVersion,
    deviceName: t('hu-agent 桌面客户端'),
  })
  return `${base}/api/v1/auth/sso/${providerId}/authorize?${query.toString()}`
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function currentPlatform(): 'win32' | 'darwin' | 'linux' {
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform
  return 'win32'
}
