/** 云账户客户端（design 4.1 / 8.1）：登录、旋转刷新、设备管理、上报鉴权。
 *
 * - access token 仅存内存；refresh token 存 safeStorage 密钥库
 * - 401 自动 refresh 一次后重试；刷新失败即视为登出
 * - 网络超时按 8.2：GET 重试 3 次，写接口不自动重试
 */

import type { CloudConfig, CloudStore } from './store'

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
  ) {}

  /** 是否已登录（本地有刷新令牌 + 账号信息）。 */
  async isLoggedIn(): Promise<boolean> {
    const config = await this.store.load()
    return Boolean(config.userId) && this.secrets.has(REFRESH_TOKEN_KEY)
  }

  async config(): Promise<CloudConfig> {
    return this.store.load()
  }

  async login(serverUrl: string, email: string, password: string): Promise<CloudUser> {
    const base = normalizeServerUrl(serverUrl)
    if (!base) throw new CloudError('VALIDATION_FAILED', '请填写服务器地址', 0)
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

  /** 上报等外部调用使用的鉴权请求。 */
  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const config = await this.store.load()
    if (!config.serverUrl) throw new CloudError('UNAUTHENTICATED', '未配置服务器地址', 0)

    let attempt = 0
    for (;;) {
      const token = options.auth === false ? null : await this.ensureAccessToken()
      try {
        return await this.fetchJson(`${config.serverUrl}${path}`, { ...options, token })
      } catch (error) {
        if (error instanceof CloudError && error.status === 401 && options.auth !== false && attempt === 0) {
          this.accessToken = null
          this.accessExpiresAt = 0
          attempt += 1
          continue
        }
        throw error
      }
    }
  }

  private async ensureAccessToken(): Promise<string | null> {
    if (this.accessToken && Date.now() < this.accessExpiresAt - 30_000) return this.accessToken
    const refreshToken = this.secrets.get(REFRESH_TOKEN_KEY)
    if (!refreshToken) throw new CloudError('UNAUTHENTICATED', '未登录', 401)
    const config = await this.store.load()
    const response = await this.fetchJson(`${config.serverUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: { refreshToken },
      timeoutMs: 15_000,
    })
    this.accessToken = String(response.accessToken)
    this.accessExpiresAt = Date.now() + (Number(response.expiresIn) || 900) * 1000
    await this.secrets.set(REFRESH_TOKEN_KEY, String(response.refreshToken))
    return this.accessToken
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
          throw new CloudError(
            String(data.code ?? 'INTERNAL'),
            String(data.message ?? `请求失败（HTTP ${response.status}）`),
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
    throw new CloudError('NETWORK', lastError instanceof Error ? lastError.message : '网络请求失败', 0)
  }
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
