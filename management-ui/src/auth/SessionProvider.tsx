/**
 * 会话上下文（design 7.1）：登录态、用户资料、语言偏好同步、登出。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { setRefreshHandler, setUnauthorizedHandler } from '../api/client'
import { meApi, type Profile } from '../api/endpoints'
import i18n from '../i18n'
import { clearSession, login as loginRequest, logout as logoutRequest, refreshSession, restoreSession } from './session'

export type SessionStatus = 'loading' | 'anonymous' | 'ready'

interface SessionValue {
  status: SessionStatus
  profile: Profile | null
  login(email: string, password: string): Promise<void>
  logout(): Promise<void>
  patchProfile(patch: { displayName?: string; locale?: 'zh-CN' | 'en-US' }): Promise<void>
  reloadProfile(): Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading')
  const [profile, setProfile] = useState<Profile | null>(null)

  // 客户端 401 → 刷新一次；刷新失败 → 清会话回登录页
  useEffect(() => {
    setRefreshHandler(refreshSession)
    setUnauthorizedHandler(() => {
      clearSession()
      setProfile(null)
      setStatus('anonymous')
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const restored = await restoreSession()
      if (cancelled) return
      setProfile(restored)
      setStatus(restored ? 'ready' : 'anonymous')
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 服务端语言偏好 → 界面语言（design 7.1：语言偏好存入用户设置）
  useEffect(() => {
    if (profile?.locale && profile.locale !== i18n.language) {
      void i18n.changeLanguage(profile.locale)
    }
  }, [profile?.locale])

  const login = useCallback(async (email: string, password: string) => {
    const next = await loginRequest(email, password)
    setProfile(next)
    setStatus('ready')
  }, [])

  const logout = useCallback(async () => {
    await logoutRequest()
    setProfile(null)
    setStatus('anonymous')
  }, [])

  const patchProfile = useCallback(async (patch: { displayName?: string; locale?: 'zh-CN' | 'en-US' }) => {
    const next = await meApi.patch(patch)
    setProfile(next)
  }, [])

  const reloadProfile = useCallback(async () => {
    if (status !== 'ready') return
    setProfile(await meApi.profile())
  }, [status])

  const value = useMemo<SessionValue>(
    () => ({ status, profile, login, logout, patchProfile, reloadProfile }),
    [status, profile, login, logout, patchProfile, reloadProfile],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession 必须在 SessionProvider 内使用')
  return value
}
