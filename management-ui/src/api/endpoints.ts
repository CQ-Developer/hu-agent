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
export type McpServer = Schema['McpServerOut']
export type McpServerDetail = Schema['McpServerDetailOut']
export type McpVersion = Schema['McpVersionOut']
export type McpEnvField = Schema['McpEnvField']
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
export type AdminUser = Schema['AdminUserOut']
export type PendingInvitation = Schema['PendingInvitationOut']
export type ResetPasswordToken = Schema['ResetPasswordOut']

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
  ssoExchange: (code: string, codeVerifier: string) => ssoApi.exchange(code, codeVerifier),
  // 公开接口：兑换管理员签发的一次性重置令牌
  resetPassword: (token: string, password: string) =>
    api.post<{ status: string }>('/api/v1/auth/password/reset', { token, password }, { auth: false }),
  logout: (allDevices = false) =>
    api.post<Record<string, unknown>>('/api/v1/auth/logout', { allDevices, deviceId: 'management-ui' }),
}

export const ssoApi = {
  // 公开接口：返回 {providers:[...]}；type='local' 为本地账号/注册的占位项，不作为 SSO 按钮
  providers: () =>
    api.get<{ providers: { id: string; type: string; name: string; enabled: boolean }[] }>(
      '/api/v1/auth/providers',
      { auth: false },
    ),
  exchange: (code: string, codeVerifier: string) =>
    api.post<Token>('/api/v1/auth/sso/exchange', { code, codeVerifier }, { auth: false }),
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
  invitations: (orgId: string) => api.get<PendingInvitation[]>(`/api/v1/orgs/${orgId}/invitations`),
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
  invitations: (teamId: string) => api.get<PendingInvitation[]>(`/api/v1/teams/${teamId}/invitations`),
}

// ---------- 邀请（跨组织/团队） ----------
export const invitationApi = {
  // 仅对应范围的组织/团队管理员（或系统管理员）可撤销
  revoke: (invitationId: string) =>
    api.post<Schema['InvitationRevokedOut']>('/api/v1/invitations:revoke', { invitationId }),
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

// ---------- MCP（团队资源） ----------
export const mcpApi = {
  listTeam: (teamId: string, params: { status?: string; q?: string; limit?: number; offset?: number } = {}) =>
    api.get<{ items: McpServer[]; total: number }>(`/api/v1/teams/${teamId}/mcp-servers`, {
      query: { status: params.status, q: params.q, limit: params.limit ?? 50, offset: params.offset ?? 0 },
    }),
  detail: (serverId: string) => api.get<McpServerDetail>(`/api/v1/mcp-servers/${serverId}`),
  publish: (serverId: string) => api.post<Record<string, unknown>>(`/api/v1/mcp-servers/${serverId}:publish`),
  delist: (serverId: string) => api.post<Record<string, unknown>>(`/api/v1/mcp-servers/${serverId}:delist`),
  enable: (serverId: string) => api.post<Record<string, unknown>>(`/api/v1/mcp-servers/${serverId}:enable`),
  disable: (serverId: string, reason: string) =>
    api.post<Record<string, unknown>>(`/api/v1/mcp-servers/${serverId}:disable`, undefined, { query: { reason } }),
  remove: (serverId: string) => api.del<Record<string, unknown>>(`/api/v1/mcp-servers/${serverId}`),
  // 替代版本由服务端自动推导（最新已发布/曾发布版本）
  revokeVersion: (serverId: string, version: number, reason: string) =>
    api.post<Record<string, unknown>>(`/api/v1/mcp-servers/${serverId}/versions/${version}:revoke`, undefined, {
      query: { reason },
    }),
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

// ---------- 运维管理（系统管理员，design 7.2） ----------
export interface AuditEntry {
  id: number
  orgId: string | null
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  detail: Record<string, unknown>
  createdAt: string
}

export interface SettingItem {
  key: string
  value: number | string
  valueType: 'int' | 'str'
  minValue: number | null
  default: number | string
  updatedAt: string | null
}

export interface ModelPrice {
  provider: string
  model: string
  currency: string
  inputPrice: number
  outputPrice: number
  cacheReadPrice: number
  cacheWritePrice: number
  effectiveFrom: string
}

export const adminApi = {
  audit: (params: {
    action?: string
    actorId?: string
    orgId?: string
    targetType?: string
    dateFrom?: string
    dateTo?: string
    limit?: number
    offset?: number
  }) =>
    api.get<{ items: AuditEntry[]; total: number }>('/api/v1/admin/audit', {
      query: {
        action: params.action,
        actor_id: params.actorId,
        org_id: params.orgId,
        target_type: params.targetType,
        date_from: params.dateFrom,
        date_to: params.dateTo,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      },
    }),
  settings: () => api.get<{ items: SettingItem[] }>('/api/v1/admin/settings'),
  updateSettings: (values: Record<string, number | string>) =>
    api.patch<{ items: SettingItem[] }>('/api/v1/admin/settings', { values }),
  prices: (params: { provider?: string; model?: string } = {}) =>
    api.get<ModelPrice[]>('/api/v1/admin/prices', { query: { provider: params.provider, model: params.model } }),
  upsertPrice: (payload: ModelPrice) => api.post<ModelPrice>('/api/v1/admin/prices', payload),
  deletePrice: (provider: string, model: string, effectiveFrom: string) =>
    api.del<{ deleted: number }>('/api/v1/admin/prices', {
      query: { provider, model, effective_from: effectiveFrom },
    }),
  freezeOrg: (orgId: string) =>
    api.post<{ id: string; status: string }>(`/api/v1/admin/orgs/${orgId}:freeze`),
  unfreezeOrg: (orgId: string) =>
    api.post<{ id: string; status: string }>(`/api/v1/admin/orgs/${orgId}:unfreeze`),
  dissolveOrg: (orgId: string) =>
    api.post<{ id: string; status: string }>(`/api/v1/admin/orgs/${orgId}:dissolve`),
  users: (params: {
    q?: string
    status?: 'active' | 'disabled' | 'pending_deletion'
    limit?: number
    offset?: number
  } = {}) =>
    api.get<{ items: AdminUser[]; total: number }>('/api/v1/admin/users', {
      query: {
        q: params.q,
        status: params.status,
        limit: params.limit ?? 50,
        offset: params.offset ?? 0,
      },
    }),
  disableUser: (userId: string, reason?: string) =>
    api.post<Schema['UserActionOut']>(`/api/v1/admin/users/${userId}:disable`, { reason }),
  enableUser: (userId: string) => api.post<Schema['UserActionOut']>(`/api/v1/admin/users/${userId}:enable`),
  forceLogoutUser: (userId: string) =>
    api.post<{ revoked: number }>(`/api/v1/admin/users/${userId}:force-logout`),
  restoreUser: (userId: string) => api.post<Schema['UserActionOut']>(`/api/v1/admin/users/${userId}:restore`),
  resetUserPassword: (userId: string) =>
    api.post<ResetPasswordToken>(`/api/v1/admin/users/${userId}:reset-password`),
}

// ---------- 组织/团队治理 ----------
export const governanceApi = {
  patchOrg: (orgId: string, payload: { name?: string; description?: string }) =>
    api.patch<Org>(`/api/v1/orgs/${orgId}`, payload),
  orgTeams: (orgId: string) => api.get<{ items: Team[]; total: number }>(`/api/v1/orgs/${orgId}/teams`),
  patchTeam: (teamId: string, payload: { name?: string; description?: string; status?: 'active' | 'archived' }) =>
    api.patch<Team>(`/api/v1/teams/${teamId}`, payload),
  applyTeam: (orgId: string, name: string, description: string, reason: string) =>
    api.post<{ approvalId: string; status: string }>('/api/v1/teams:apply', {
      orgId,
      name,
      description,
      reason,
    }),
  applyOrg: (name: string, slug: string, description: string, reason: string) =>
    api.post<{ approvalId: string; status: string }>('/api/v1/orgs:apply', { name, slug, description, reason }),
}
