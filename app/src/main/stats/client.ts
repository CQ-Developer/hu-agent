/** 统计 API 客户端（design 6.7.2）：用量聚合、激活明细、我的团队/组织（用于范围选择）。 */

import type { CloudClient } from '../cloud/client'

export type StatsScope = 'self' | 'team' | 'org' | 'global'
export type UsageGroupBy = 'day' | 'model' | 'member' | 'team' | 'org'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  errors: number
  estimatedCost: number
}

export interface UsageRow {
  key: string
  day?: string | null
  userId?: string | null
  teamId?: string | null
  orgId?: string | null
  provider?: string | null
  model?: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  errors: number
  estimatedCost: number
}

export interface UsageView {
  scope: string
  dateFrom: string
  dateTo: string
  groupBy: string
  currency: string
  totals: UsageTotals
  rows: UsageRow[]
}

export interface ActivationView {
  userId: string
  email: string
  resourceType: string
  refId: string | null
  name: string
  version: string | null
  enabled: boolean
  deviceCount: number
  lastReportedAt: string
  serverState: string | null
}

export interface TeamOption {
  id: string
  name: string
  orgId: string
  myRole: string | null
}

export interface OrgOption {
  id: string
  name: string
  slug: string
  role: string | null
}

export class StatsClient {
  constructor(private readonly cloud: CloudClient) {}

  async usage(params: {
    scope: StatsScope
    from: string
    to: string
    groupBy: UsageGroupBy
    teamId?: string
    orgId?: string
  }): Promise<UsageView> {
    const query = new URLSearchParams({
      scope: params.scope,
      from: params.from,
      to: params.to,
      groupBy: params.groupBy,
    })
    if (params.teamId) query.set('team_id', params.teamId)
    if (params.orgId) query.set('org_id', params.orgId)
    return (await this.cloud.request(`/api/v1/stats/usage?${query.toString()}`)) as UsageView
  }

  async activations(params: {
    scope: StatsScope
    teamId?: string
    orgId?: string
    type?: 'skill' | 'mcp'
  }): Promise<ActivationView[]> {
    const query = new URLSearchParams({ scope: params.scope })
    if (params.teamId) query.set('team_id', params.teamId)
    if (params.orgId) query.set('org_id', params.orgId)
    if (params.type) query.set('type', params.type)
    const response = (await this.cloud.request(`/api/v1/stats/activations?${query.toString()}`)) as {
      items: ActivationView[]
    }
    return response.items
  }

  async teams(): Promise<TeamOption[]> {
    return (await this.cloud.request('/api/v1/teams')) as TeamOption[]
  }

  async orgs(): Promise<OrgOption[]> {
    return (await this.cloud.request('/api/v1/orgs')) as OrgOption[]
  }
}
