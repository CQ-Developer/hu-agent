/**
 * HTTP 客户端（design 6.9 / 7.1）：统一错误体、Bearer 注入、401 自动刷新一次。
 *
 * - access token 仅存内存；refresh token 存 sessionStorage（关闭标签页即失效）
 * - 401 时调用注册好的刷新函数重试一次，仍失败则触发登出回调
 * - 错误统一抛 ApiError（含业务码与 traceId，便于对齐服务端日志）
 */

import type { components } from './schema'

export type ApiErrorBody = {
  code?: string
  message?: string
  traceId?: string
  details?: Record<string, unknown>
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly traceId: string | null

  constructor(status: number, code: string, message: string, traceId: string | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.traceId = traceId
  }
}

export type QueryValue = string | number | boolean | undefined | null

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
  /** 是否带 Authorization（登录/刷新等接口为 false） */
  auth?: boolean
}

type TokenHandler = () => void

let accessToken: string | null = null
let refreshHandler: (() => Promise<string | null>) | null = null
let unauthorizedHandler: TokenHandler | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function getAccessToken(): string | null {
  return accessToken
}

/** 由会话层注册：返回新的 access token，失败返回 null */
export function setRefreshHandler(handler: () => Promise<string | null>): void {
  refreshHandler = handler
}

/** 由会话层注册：刷新失败时清空会话并回到登录页 */
export function setUnauthorizedHandler(handler: TokenHandler): void {
  unauthorizedHandler = handler
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const response = await fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.auth === false || !accessToken ? {} : { Authorization: `Bearer ${accessToken}` }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  return response
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options)

  if (response.status === 401 && options.auth !== false && refreshHandler) {
    const renewed = await refreshHandler()
    if (renewed) {
      response = await send(path, options)
    } else {
      unauthorizedHandler?.()
    }
  } else if (response.status === 401 && options.auth !== false) {
    unauthorizedHandler?.()
  }

  const text = await response.text()
  const payload = text ? (JSON.parse(text) as unknown) : {}

  if (!response.ok) {
    const error = payload as ApiErrorBody
    throw new ApiError(
      response.status,
      error.code ?? 'INTERNAL',
      error.message ?? `${response.status} ${response.statusText}`,
      error.traceId ?? null,
    )
  }
  return payload as T
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method'>) => apiRequest<T>(path, options),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),
  del: <T>(path: string, options?: Omit<RequestOptions, 'method'>) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
}

export type Schema = components['schemas']
