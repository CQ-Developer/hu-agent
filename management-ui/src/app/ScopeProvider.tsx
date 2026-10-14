/**
 * 组织/团队上下文（design 7.1）：登录后拉取可见组织与团队，供页面复用；
 * 同时提供权限判定（仅做展示控制，服务端仍强制鉴权）。
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { orgApi, teamApi, type Org, type Team } from '../api/endpoints'

const ORG_KEY = 'huagent.management.orgId'
const TEAM_KEY = 'huagent.management.teamId'

interface ScopeValue {
  orgs: Org[]
  teams: Team[]
  org: Org | null
  team: Team | null
  loading: boolean
  error: string | null
  setOrgId(orgId: string | null): void
  setTeamId(teamId: string | null): void
  reload(): Promise<void>
  /** 管理员判定 */
  isSystemAdmin: boolean
  canManageOrg: boolean
  canManageTeam: boolean
  /** 我作为管理员的团队（用于 Skill/成员页面选择） */
  adminTeams: Team[]
}

const ScopeContext = createContext<ScopeValue | null>(null)

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // 忽略存储不可用
  }
}

export function ScopeProvider({ isSystemAdmin, children }: { isSystemAdmin: boolean; children: ReactNode }) {
  const [orgs, setOrgs] = useState<Org[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [orgId, setOrgIdState] = useState<string | null>(() => read(ORG_KEY))
  const [teamId, setTeamIdState] = useState<string | null>(() => read(TEAM_KEY))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [nextOrgs, nextTeams] = await Promise.all([orgApi.list(), teamApi.list()])
      setOrgs(nextOrgs)
      setTeams(nextTeams)
      setError(null)
      // 选中的组织/团队若已不可见则回退到第一个
      setOrgIdState((current) => (current && nextOrgs.some((item) => item.id === current) ? current : nextOrgs[0]?.id ?? null))
      setTeamIdState((current) => (current && nextTeams.some((item) => item.id === current) ? current : nextTeams[0]?.id ?? null))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const setOrgId = useCallback((next: string | null) => {
    setOrgIdState(next)
    write(ORG_KEY, next)
  }, [])

  const setTeamId = useCallback((next: string | null) => {
    setTeamIdState(next)
    write(TEAM_KEY, next)
  }, [])

  const value = useMemo<ScopeValue>(() => {
    const org = orgs.find((item) => item.id === orgId) ?? null
    const team = teams.find((item) => item.id === teamId) ?? null
    return {
      orgs,
      teams,
      org,
      team,
      loading,
      error,
      setOrgId,
      setTeamId,
      reload,
      isSystemAdmin,
      canManageOrg: org?.role === 'admin',
      canManageTeam: team?.myRole === 'admin',
      adminTeams: teams.filter((item) => item.myRole === 'admin'),
    }
  }, [orgs, teams, orgId, teamId, loading, error, setOrgId, setTeamId, reload, isSystemAdmin])

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export function useScope(): ScopeValue {
  const value = useContext(ScopeContext)
  if (!value) throw new Error('useScope 必须在 ScopeProvider 内使用')
  return value
}
