/**
 * 会话与令牌（design 7.1）。
 *
 * - access token 只在内存；refresh token 存 sessionStorage（关闭标签页即失效，降低 XSS 影响面）
 * - 刷新为旋转式：每次刷新拿到新的 refresh token 并覆盖旧值；失败即视为登出
 * - 由 SessionProvider 注册到 HTTP 客户端的刷新与登出回调
 */

import { authApi, meApi, type Profile } from '../api/endpoints'
import { setAccessToken } from '../api/client'

const REFRESH_KEY = 'huagent.management.refresh'

export function readRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY)
  } catch {
    return null
  }
}

export function writeRefreshToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(REFRESH_KEY, token)
    else sessionStorage.removeItem(REFRESH_KEY)
  } catch {
    // 隐私模式下 sessionStorage 可能不可用：退化为仅内存会话
  }
}

export function clearSession(): void {
  setAccessToken(null)
  writeRefreshToken(null)
}

/** 登录：保存令牌并返回用户资料 */
export async function login(email: string, password: string): Promise<Profile> {
  const token = await authApi.login(email, password)
  setAccessToken(token.accessToken)
  writeRefreshToken(token.refreshToken)
  return meApi.profile()
}

/** 刷新令牌（旋转）；返回新的 access token，失败返回 null */
export async function refreshSession(): Promise<string | null> {
  const current = readRefreshToken()
  if (!current) return null
  try {
    const renewed = await authApi.refresh(current)
    setAccessToken(renewed.accessToken)
    writeRefreshToken(renewed.refreshToken)
    return renewed.accessToken
  } catch {
    clearSession()
    return null
  }
}

/** 启动时恢复会话：有 refresh token 则尝试刷新并拉取资料 */
export async function restoreSession(): Promise<Profile | null> {
  const token = await refreshSession()
  if (!token) return null
  try {
    return await meApi.profile()
  } catch {
    clearSession()
    return null
  }
}

export async function logout(): Promise<void> {
  try {
    await authApi.logout(false)
  } catch {
    // 服务端注销失败也要清本地会话
  }
  clearSession()
}
