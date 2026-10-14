/** 云账户客户端（design 4.1 / 8.1）：登录、旋转刷新、设备管理、上报鉴权。
 *
 * - access token 仅存内存；refresh token 存 safeStorage 密钥库
 * - 401 自动 refresh 一次后重试；刷新失败即视为登出
 * - 网络超时按 8.2：GET 重试 3 次，写接口不自动重试
 */

import type { CloudConfig, CloudStore } from './store'
import { getLocale, t } from '../i18n'
import { localizeServerError } from '../../shared/i18n/error-codes'

export const REFRESH_TOKEN_KEY = 'cloud.refreshToken'

/** 最小密钥接口（SecretStore 天然满足），便于单测替换。 */
export interface SecretAccess {
  get(key: string): string | null
  has(key: string): boolean
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export class CloudError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'CloudError'
  }
}

export interface CloudHooks {
  /** 服务端明确拒绝会话（令牌撤销/账号禁用）时通知界面退回门禁（ADR 0004 / D16） */
  onSessionLost?: (reason: string) => void
}

export interface CloudRestoreResult {
  ok: boolean
  user?: CloudUser
  /** true：没有本地登录态，需要用户登录；false：有登录态但验证失败（如服务端不可达） */
  needsLogin?: boolean
  error?: string
  code?: string
}

export interface CloudUser {
  id: string
  email: string
  displayName: string
  locale: string
  isSystemAdmin: boolean
}

export interface CloudDeviceView {
  id: string
  deviceId: string
  platform: string
  appVersion: string
  name: string | null
  lastSeenAt: string | null
  createdAt: string
  current: boolean
}

interface RequestOptions {
  method?: string
  body?: unknown
  auth?: boolean
  retries?: number
  timeoutMs?: number
}

export class CloudClient {
  private accessToken: string | null = null
  private accessExpiresAt = 0

  constructor(
    private readonly secrets: SecretAccess,
    private readonly store: CloudStore,
    private readonly appVersion: string,
    private readonly hooks: CloudHooks = {},
  ) {}

  /**
   * 启动时静默恢复会话（design 4.1 + D16 强制登录）：
   * - 无本地登录态 → 需要用户登录
   * - 有登录态且服务端可达 → 刷新并返回用户
   * - 服务端明确拒绝 → 清理会话并重新登录
   * - 网络不可达 → 保留登录态，仅提示重试（不提供绕过）
   */
  async restore(): Promise<CloudRestoreResult> {
    const config = await this.store.load()
    if (!config.serverUrl || !config.userId || !this.secrets.has(REFRESH_TOKEN_KEY)) {
      return { ok: false, needsLogin: true }
    }
    try {
      await this.ensureAccessToken()
      const user = await this.me()
      await this.store.save({
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        isSystemAdmin: user.isSystemAdmin,
        locale: user.locale,
      })
      return { ok: true, user }
    } catch (error) {
      if (error instanceof CloudError && isAuthError(error)) {
        return { ok: false, needsLogin: true, error: error.message, code: error.code }
      }
      return {
        ok: false,
        needsLogin: false,
        error: error instanceof Error ? error.message : String(error),
        code: 'NETWORK',
      }
    }
  }

  /** 是否已登录（本地有刷新令牌 + 账号信息）。 */
  async isLoggedIn(): Promise<boolean> {
    const config = await this.store.load()
    return Boolean(config.userId) && this.secrets.has(REFRESH_TOKEN_KEY)
  }

  async config(): Promise<CloudConfig> {
    return this.store.load()
  }

  /** 供 SSO 流程使用（凭证/回调需要设备指纹与版本）。 */
  appVersionValue(): string {
    return this.appVersion
  }

  /** 可用登录方式（本地 + 已启用身份源）。 */
  async listProviders(serverUrl?: string): Promise<{ id: string; type: string; name: string; enabled: boolean }[]> {
    const config = await this.store.load()
    const base = normalizeServerUrl(serverUrl ?? config.serverUrl)
    if (!base) throw new CloudError('VALIDATION_FAILED', t('请填写服务器地址'), 0)
    const response = await this.fetchJson(`${base}/api/v1/auth/providers`, { timeoutMs: 15_000 })
    const providers = (response.providers ?? []) as { id: string; type: string; name: string; enabled: boolean }[]
    return providers
  }

  /** SSO 一次性 code 换本地会话（design 6.12.3）。 */
  async ssoExchange(serverUrl: string, code: string, codeVerifier: string): Promise<CloudUser> {
    const base = normalizeServerUrl(serverUrl)
    if (!base) throw new CloudError('VALIDATION_FAILED', t('请填写服务器地址'), 0)
    const response = await this.fetchJson(`${base}/api/v1/auth/sso/exchange`, {
      method: 'POST',
      body: { code, codeVerifier },
      timeoutMs: 30_000,
    })
    return this.persistSession(response, base)
  }

  async login(serverUrl: string, email: string, password: string): Promise<CloudUser> {
    const base = normalizeServerUrl(serverUrl)
    if (!base) throw new CloudError('VALIDATION_FAILED', t('请填写服务器地址'), 0)
    const config = await this.store.load()
    const response = await this.fetchJson(`${base}/api/v1/auth/login`, {
      method: 'POST',
      body: {
        email,
        password,
        device: {
          deviceId: config.deviceId,
          platform: currentPlatform(),
          appVersion: this.appVersion,
          name: null,
        },
      },
      timeoutMs: 15_000,
    })
    return this.persistSession(response, base)
  }

  /** 登录/SSO 成功后统一保存令牌与账号信息。 */
  private async persistSession(response: Record<string, unknown>, base: string): Promise<CloudUser> {
    const user = response.user as CloudUser
    this.accessToken = String(response.accessToken)
    this.accessExpiresAt = Date.now() + (Number(response.expiresIn) || 900) * 1000
    await this.secrets.set(REFRESH_TOKEN_KEY, String(response.refreshToken))
    await this.store.save({
      serverUrl: base,
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      isSystemAdmin: user.isSystemAdmin,
      locale: user.locale,
    })
    return user
  }

  /** 邮箱注册（服务端可通过配置关闭，此时返回 FORBIDDEN）。 */
  async register(serverUrl: string, email: string, displayName: string, password: string): Promise<CloudUser> {
    const base = normalizeServerUrl(serverUrl)
    if (!base) throw new CloudError('VALIDATION_FAILED', t('请填写服务器地址'), 0)
    await this.fetchJson(`${base}/api/v1/auth/register`, {
      method: 'POST',
      body: { email, password, displayName },
      timeoutMs: 15_000,
    })
    return this.login(base, email, password)
  }

  async logout(allDevices = false): Promise<void> {
    const config = await this.store.load()
    if (config.userId && this.secrets.has(REFRESH_TOKEN_KEY)) {
      try {
        await this.request('/api/v1/auth/logout', {
          method: 'POST',
          body: { allDevices, deviceId: config.deviceId },
          timeoutMs: 10_000,
        })
      } catch {
        // 服务端不可达也要完成本地登出
      }
    }
    await this.clearSession()
  }

  async clearSession(): Promise<void> {
    this.accessToken = null
    this.accessExpiresAt = 0
    await this.secrets.delete(REFRESH_TOKEN_KEY)
    await this.store.clearAccount()
  }

  async me(): Promise<CloudUser> {
    return (await this.request('/api/v1/me')) as CloudUser
  }

  async devices(): Promise<CloudDeviceView[]> {
    const response = (await this.request('/api/v1/me/devices')) as { devices: CloudDeviceView[] }
    return response.devices
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.request(`/api/v1/me/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' })
    const config = await this.store.load()
    if (deviceId === config.deviceId) await this.clearSession()
  }

  /** 同步语言偏好到 users.locale（通知/邮件按该值渲染，design 5.13）。 */
  async updateLocale(locale: 'zh-CN' | 'en-US'): Promise<void> {
    await this.request('/api/v1/me', { method: 'PATCH', body: { locale } })
  }

  /** 上报等外部调用使用的鉴权请求。 */
  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const config = await this.store.load()
    if (!config.serverUrl) throw new CloudError('UNAUTHENTICATED', t('未配置服务器地址'), 0)

    let retried = false
    for (;;) {
      let token: string | null = null
      try {
        token = options.auth === false ? null : await this.ensureAccessToken()
        return await this.fetchJson(`${config.serverUrl}${path}`, { ...options, token })
      } catch (error) {
        if (isAuthError(error) && options.auth !== false) {
          // 请求期间 access token 过期：清掉后重试一次；再失败则判定会话失效（ADR 0004）
          if (token && !retried) {
            retried = true
            this.accessToken = null
            this.accessExpiresAt = 0
            continue
          }
          await this.invalidateSession(error)
        }
        throw error
      }
    }
  }

  private async ensureAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 30_000) return this.accessToken
    const refreshToken = this.secrets.get(REFRESH_TOKEN_KEY)
    if (!refreshToken) throw new CloudError('UNAUTHENTICATED', t('未登录'), 401)
    const config = await this.store.load()
    try {
      const response = await this.fetchJson(`${config.serverUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        body: { refreshToken },
        timeoutMs: 15_000,
      })
      this.accessToken = String(response.accessToken)
      this.accessExpiresAt = Date.now() + (Number(response.expiresIn) || 900) * 1000
      await this.secrets.set(REFRESH_TOKEN_KEY, String(response.refreshToken))
      return this.accessToken
    } catch (error) {
      // 刷新被服务端拒绝（旋转令牌失效/账号禁用）→ 会话作废，界面退回门禁
      if (isAuthError(error)) await this.invalidateSession(error)
      throw error
    }
  }

  /** 仅由服务端拒绝触发（用户主动登出不走这里）。 */
  private async invalidateSession(error: CloudError): Promise<void> {
    const hadSession = this.secrets.has(REFRESH_TOKEN_KEY)
    await this.clearSession()
    if (hadSession) this.hooks.onSessionLost?.(error.message)
  }

  private async fetchJson(
    url: string,
    options: RequestOptions & { token?: string | null },
  ): Promise<Record<string, unknown>> {
    const retries = options.retries ?? (options.method && options.method !== 'GET' ? 0 : 3)
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: options.method ?? 'GET',
          headers: {
            'content-type': 'application/json',
            'x-client-version': this.appVersion,
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        })
        const text = await response.text()
        const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
        if (!response.ok) {
          // 业务码由客户端本地化（design 6.9.1）：服务端文案仅作为中文界面下的细节
          const code = String(data.code ?? 'INTERNAL')
          const fallback = t('请求失败（HTTP {status}）', { status: response.status })
          throw new CloudError(
            code,
            localizeServerError(getLocale(), code, String(data.message ?? fallback)),
            response.status,
          )
        }
        return data
      } catch (error) {
        lastError = error
        const retryable =
          !(error instanceof CloudError) || error.status >= 500 || error.code === 'INTERNAL'
        if (attempt >= retries || !retryable) break
        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
      }
    }
    if (lastError instanceof CloudError) throw lastError
    throw new CloudError('NETWORK', lastError instanceof Error ? lastError.message : t('网络请求失败'), 0)
  }
}

function isAuthError(error: unknown): error is CloudError {
  if (!(error instanceof CloudError)) return false
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.code === 'UNAUTHENTICATED' ||
    error.code === 'REFRESH_REVOKED' ||
    error.code === 'ACCOUNT_DISABLED'
  )
}

export function normalizeServerUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(trimmed)) return ''
  return trimmed
}

export function currentPlatform(): 'win32' | 'darwin' | 'linux' {
  if (process.platform === 'darwin' || process.platform === 'linux') return process.platform
  return 'win32'
}
