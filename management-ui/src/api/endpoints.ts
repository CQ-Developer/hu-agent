/**
 * 服务端接口封装（design 7.1）：类型来自 openapi-typescript 生成的 schema.d.ts，
 * 本文件只做路径与参数的轻封装，不重复定义类型。
 *
 * 重新生成：`npm run api:gen`（见 package.json，使用 npx 临时运行，不写入依赖）
 */

import { api, type Schema } from './client'

export type Profile = Schema['ProfileOut']
export type Token = Schema['TokenOut']
export type Approval = Schema['ApprovalOut']
export type Skill = Schema['SkillOut']
export type SkillDetail = Schema['SkillDetailOut']
export type SkillVersion = Schema['SkillVersionOut']
export type Org = Schema['OrgOut']
export type Team = Schema['TeamOut']
export type OrgMember = Schema['OrgMemberOut']
export type TeamMember = Schema['TeamMemberOut']
export type IdentityProvider = Schema['ProviderOut']
export type Notification = Schema['NotificationOut']
export type Usage = Schema['UsageOut']
export type Activation = Schema['ActivationOut']
export type Device = Schema['DeviceOut']
export type Identity = Schema['IdentityOut']

export interface InvitationCreated {
  id: string
  email: string
  role: string
  type: 'org' | 'team'
  expiresAt: string
  accepted: boolean
  /** 一次性邀请码：仅创建时返回，需管理员转交本人 */
  acceptToken: string
}

export interface IdentityProviderInput {
  name: string
  issuerUrl: string
  clientId: string
  clientSecret?: string | null
  scopes?: string
  enabled?: boolean
  allowedEmailDomains?: string[]
  autoJoinOrgId?: string | null
  allowAutoLink?: boolean
}

export interface NotificationList {
  items: Notification[]
  unread: number
}

// ---------- 认证 / 个人 ----------
export const authApi = {
  login: (email: string, password: string) =>
    api.post<Token>(
      '/api/v1/auth/login',
      { email, password, device: { deviceId: 'management-ui', platform: 'web', appVersion: '0.1.0', name: 'hu-agent 管理台' } },
      { auth: false },
    ),
  refresh: (refreshToken: string) =>
    api.post<Schema['RefreshOut']>('/api/v1/auth/refresh', { refreshToken }, { auth: false }),
  // 服务端按 device_id / all_devices 注销会话（管理台固定用自己的 deviceId）
  logout: (allDevices = false) =>
    api.post<Record<string, unknown>>('/api/v1/auth/logout', { allDevices, deviceId: 'management-ui' }),
}

export const meApi = {
  profile: () => api.get<Profile>('/api/v1/me'),
  patch: (patch: { displayName?: string; locale?: 'zh-CN' | 'en-US' }) =>
    api.patch<Profile>('/api/v1/me', patch),
  notifications: (unreadOnly = false) =>
    api.get<NotificationList>('/api/v1/me/notifications', { query: { unread_only: unreadOnly } }),
  markNotifications: (all = true) =>
    api.patch<{ updated: number }>('/api/v1/me/notifications', { all }),
  // 注意：/me/devices 返回 { devices: [...] }（DevicesOut），/me/identities 返回数组
  devices: () => api.get<{ devices: Device[] }>('/api/v1/me/devices'),
  revokeDevice: (deviceId: string) => api.del<Record<string, unknown>>(`/api/v1/me/devices/${deviceId}`),
  identities: () => api.get<Identity[]>('/api/v1/me/identities'),
  unlinkIdentity: (identityId: string) => api.del<Record<string, unknown>>(`/api/v1/me/identities/${identityId}`),
}

// ---------- 组织 / 团队 ----------
export const orgApi = {
  list: () => api.get<Org[]>('/api/v1/orgs'),
  members: (orgId: string) => api.get<{ items: OrgMember[]; total: number }>(`/api/v1/orgs/${orgId}/members`),
  setMemberRole: (orgId: string, userId: string, role: 'admin' | 'member') =>
    api.patch<OrgMember>(`/api/v1/orgs/${orgId}/members/${userId}`, { role }),
  removeMember: (orgId: string, userId: string) =>
    api.del<Record<string, unknown>>(`/api/v1/orgs/${orgId}/members/${userId}`),
  invite: (orgId: string, email: string, role: 'admin' | 'member') =>
    api.post<InvitationCreated>(`/api/v1/orgs/${orgId}/invitations`, { email, role }),
  teams: (orgId: string) => api.get<Team[]>(`/api/v1/orgs/${orgId}/teams`),
}

export const teamApi = {
  list: () => api.get<Team[]>('/api/v1/teams'),
  get: (teamId: string) => api.get<Team>(`/api/v1/teams/${teamId}`),
  members: (teamId: string) => api.get<{ items: TeamMember[]; total: number }>(`/api/v1/teams/${teamId}/members`),
  setMemberRole: (teamId: string, userId: string, role: 'admin' | 'member') =>
    api.patch<TeamMember>(`/api/v1/teams/${teamId}/members/${userId}`, { role }),
  removeMember: (teamId: string, userId: string) =>
    api.del<Record<string, unknown>>(`/api/v1/teams/${teamId}/members/${userId}`),
  invite: (teamId: string, email: string, role: 'admin' | 'member') =>
    api.post<InvitationCreated>(`/api/v1/teams/${teamId}/invitations`, { email, role }),
}

// ---------- 审批 ----------
export const approvalApi = {
  list: (params: {
    scope: 'system' | 'org' | 'team' | 'mine'
    orgId?: string
    teamId?: string
    status?: string
    limit?: number
    offset?: number
  }) =>
    api.get<{ items: Approval[]; total: number }>('/api/v1/approvals', {
      query: {
        scope: params.scope,
        org_id: params.orgId,
        team_id: params.teamId,
        status: params.status,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      },
    }),
  get: (approvalId: string) => api.get<Approval>(`/api/v1/approvals/${approvalId}`),
  approve: (approvalId: string, comment?: string) =>
    api.post<Approval>(`/api/v1/approvals/${approvalId}:approve`, { comment }),
  reject: (approvalId: string, comment: string) =>
    api.post<Approval>(`/api/v1/approvals/${approvalId}:reject`, { comment }),
  cancel: (approvalId: string) => api.post<Approval>(`/api/v1/approvals/${approvalId}:cancel`),
}

// ---------- Skill（团队资源） ----------
export const skillApi = {
  listTeam: (teamId: string, params: { status?: string; q?: string; limit?: number; offset?: number } = {}) =>
    api.get<{ items: Skill[]; total: number }>(`/api/v1/teams/${teamId}/skills`, {
      query: { status: params.status, q: params.q, limit: params.limit ?? 50, offset: params.offset ?? 0 },
    }),
  detail: (skillId: string) => api.get<SkillDetail>(`/api/v1/skills/${skillId}`),
  publish: (skillId: string) => api.post<Record<string, unknown>>(`/api/v1/skills/${skillId}:publish`),
  delist: (skillId: string) => api.post<Record<string, unknown>>(`/api/v1/skills/${skillId}:delist`),
  enable: (skillId: string) => api.post<Record<string, unknown>>(`/api/v1/skills/${skillId}:enable`),
  disable: (skillId: string, reason: string) =>
    api.post<Record<string, unknown>>(`/api/v1/skills/${skillId}:disable`, undefined, { query: { reason } }),
  remove: (skillId: string) => api.del<Record<string, unknown>>(`/api/v1/skills/${skillId}`),
  // 替代版本由服务端自动推导（latest published）
  revokeVersion: (skillId: string, version: string, reason: string) =>
    api.post<Record<string, unknown>>(`/api/v1/skills/${skillId}/versions/${version}:revoke`, undefined, {
      query: { reason },
    }),
  downloadUrl: (skillId: string, version: string) =>
    api.get<{ url: string; expiresIn: number }>(`/api/v1/skills/${skillId}/versions/${version}/download-url`),
}

// ---------- 身份源（系统管理员） ----------
export const identityApi = {
  list: () => api.get<IdentityProvider[]>('/api/v1/admin/identity-providers'),
  create: (payload: IdentityProviderInput) =>
    api.post<IdentityProvider>('/api/v1/admin/identity-providers', payload),
  update: (providerId: string, payload: Partial<IdentityProviderInput>) =>
    api.patch<IdentityProvider>(`/api/v1/admin/identity-providers/${providerId}`, payload),
  remove: (providerId: string) => api.del<Record<string, unknown>>(`/api/v1/admin/identity-providers/${providerId}`),
}

// ---------- 统计 ----------
export const statsApi = {
  usage: (params: {
    scope: 'self' | 'team' | 'org' | 'global'
    from: string
    to: string
    groupBy: 'day' | 'model' | 'member' | 'team' | 'org'
    teamId?: string
    orgId?: string
  }) =>
    api.get<Usage>('/api/v1/stats/usage', {
      query: {
        scope: params.scope,
        from: params.from,
        to: params.to,
        groupBy: params.groupBy,
        team_id: params.teamId,
        org_id: params.orgId,
      },
    }),
  activations: (params: { scope: 'self' | 'team' | 'org' | 'global'; teamId?: string; orgId?: string } = { scope: 'self' }) =>
    api.get<{ items: Activation[]; total: number }>('/api/v1/stats/activations', {
      query: { scope: params.scope, team_id: params.teamId, org_id: params.orgId },
    }),
}

export const systemApi = {
  health: () => api.get<{ status: string; time: string }>('/api/v1/system/health', { auth: false }),
}
