/**
 * 管理台 SSO 登录（design 6.12.3 / 7.2）：浏览器端 PKCE（S256），三方流程：
 *   管理台 → 服务端 /auth/sso/{provider}/authorize → IdP → 服务端 /auth/sso/callback
 *   → 302 回管理台 /sso/callback?code=… → 管理台 /auth/sso/exchange 换本地令牌
 *
 * 注意：回跳地址必须是回环地址（开发）或已登记在服务端 cors_origins（生产），
 * 详见 deployment.md 的 CORS_ORIGINS 配置。
 */

import { authApi, meApi, type Profile, type Token } from '../api/endpoints'
import { setAccessToken } from '../api/client'
import { writeRefreshToken } from './session'

const VERIFIER_KEY = 'huagent.management.sso.verifier'
const STATE_KEY = 'huagent.management.sso.state'

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(bytes = 32): string {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return base64Url(buffer)
}

async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export function callbackUrl(): string {
  return `${window.location.origin}/sso/callback`
}

/** 跳转到 IdP（当前页被替换，返回时走 /sso/callback） */
export async function beginSsoLogin(providerId: string): Promise<void> {
  const verifier = randomString(48)
  const state = randomString(16)
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(STATE_KEY, state)
  const params = new URLSearchParams({
    redirect_uri: callbackUrl(),
    state,
    code_challenge: await s256Challenge(verifier),
    code_challenge_method: 'S256',
    device_id: 'management-ui',
    platform: 'web',
    app_version: '0.1.0',
  })
  window.location.href = `/api/v1/auth/sso/${providerId}/authorize?${params.toString()}`
}

/** 处理回调：校验 state、用 code + verifier 换令牌并加载资料 */
export async function completeSsoLogin(code: string, state: string): Promise<Profile> {
  const expected = sessionStorage.getItem(STATE_KEY)
  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  sessionStorage.removeItem(STATE_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)
  if (!expected || expected !== state) throw new Error('SSO state 不匹配，请重试')
  if (!verifier) throw new Error('SSO 会话已过期，请重新登录')

  const token: Token = await authApi.ssoExchange(code, verifier)
  setAccessToken(token.accessToken)
  writeRefreshToken(token.refreshToken)
  return meApi.profile()
}
