import { useEffect, useState } from 'react'

import type { Team } from '../../api/endpoints'
import { useScope } from '../../app/ScopeProvider'

/**
 * 资源管理页的团队选择（Skill / MCP 共用）：默认跟随顶部团队（若我是其管理员），
 * 否则回退到第一个可管理团队。
 */
export interface AdminTeamSelection {
  teamId: string | undefined
  setTeamId: (id: string) => void
  teams: Team[]
}

export function useAdminTeam(): AdminTeamSelection {
  const scope = useScope()
  const [teamId, setTeamId] = useState<string | undefined>(scope.team?.id)

  useEffect(() => {
    const selected = scope.team?.id
    if (selected && scope.adminTeams.some((team) => team.id === selected)) {
      setTeamId((current) => (current === selected ? current : selected))
      return
    }
    if (!teamId && scope.adminTeams.length) setTeamId(scope.adminTeams[0].id)
  }, [scope.team?.id, scope.adminTeams, teamId])

  return { teamId, setTeamId, teams: scope.adminTeams }
}
