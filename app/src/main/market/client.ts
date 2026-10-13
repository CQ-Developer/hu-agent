/** 市场 API 客户端（design 6.4.4 / 5.7.4）：列表、详情、预签名下载、状态查询、激活上报。 */

import type { CloudClient } from '../cloud/client'

export interface MarketSkill {
  id: string
  orgId: string
  teamId: string
  name: string
  description: string
  tags: string[]
  status: string
  statusRevision: number
  latestVersion: string | null
  downloadCount: number
  updatedAt: string
}

export interface MarketVersion {
  id: string
  version: string
  status: string
  digest: string
  sizeBytes: number
  fileCount: number
  changelog: string | null
  downloadCount: number
  createdAt: string
}

export interface MarketSkillDetail extends MarketSkill {
  disabledReason: string | null
  manifest: {
    frontMatter?: {
      name?: string
      description?: string
      version?: string
      whenToUse?: string
      minAppVersion?: string
      tags?: string[]
      requires?: { tools?: string[]; bins?: string[]; network?: boolean }
    }
    files?: { path: string; size: number; script: boolean }[]
    scripts?: string[]
  }
  skillMd: string
  versions: MarketVersion[]
}

export interface DownloadInfo {
  url: string
  expiresIn: number
  digest: string
  version: string
}

export type ResourceState = 'active' | 'delisted' | 'disabled' | 'revoked' | 'not_found' | 'unknown'

export interface StatusCheckItem {
  type: 'skill' | 'mcp'
  refId: string
  version: string | null
}

export interface StatusCheckResult {
  type: string
  refId: string
  version: string | null
  status: ResourceState
  reason: string | null
  replacementVersion: string | null
  revision: number | null
}

export interface ActivationItem {
  type: 'skill' | 'mcp'
  source: 'market' | 'local'
  refId: string | null
  name: string
  version: string | null
  enabled: boolean
}

export class MarketClient {
  constructor(private readonly cloud: CloudClient) {}

  async listSkills(params: { q?: string; tag?: string; sort?: 'updated' | 'name' | 'downloads' } = {}): Promise<{
    items: MarketSkill[]
    total: number
  }> {
    const query = new URLSearchParams()
    if (params.q) query.set('q', params.q)
    if (params.tag) query.set('tag', params.tag)
    if (params.sort) query.set('sort', params.sort)
    const suffix = query.size > 0 ? `?${query.toString()}` : ''
    return (await this.cloud.request(`/api/v1/marketplace/skills${suffix}`)) as {
      items: MarketSkill[]
      total: number
    }
  }

  async skillDetail(skillId: string): Promise<MarketSkillDetail> {
    return (await this.cloud.request(`/api/v1/skills/${skillId}`)) as MarketSkillDetail
  }

  async downloadUrl(skillId: string, version: string): Promise<DownloadInfo> {
    return (await this.cloud.request(
      `/api/v1/skills/${skillId}/versions/${encodeURIComponent(version)}/download-url`,
    )) as DownloadInfo
  }

  /** 下载预签名对象（S3 直连，不需要鉴权头）。 */
  async download(url: string): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    return Buffer.from(await response.arrayBuffer())
  }

  async checkStatus(items: StatusCheckItem[]): Promise<StatusCheckResult[]> {
    const response = (await this.cloud.request('/api/v1/resources/status:check', {
      method: 'POST',
      body: { items },
      timeoutMs: 30_000,
    })) as { items: StatusCheckResult[] }
    return response.items
  }

  async reportActivations(payload: {
    deviceId: string
    scope: 'global' | 'workspace'
    workspaceId?: string | null
    items: ActivationItem[]
  }): Promise<void> {
    await this.cloud.request('/api/v1/me/activations:report', {
      method: 'POST',
      body: {
        deviceId: payload.deviceId,
        scope: payload.scope,
        workspaceId: payload.workspaceId ?? null,
        items: payload.items,
      },
      timeoutMs: 30_000,
    })
  }
}
