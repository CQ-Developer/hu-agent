/** 同步后端实现：把 SyncEngine 的调用映射到服务端接口（design 6.6.2）。 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'

import { CloudError, type CloudClient } from '../cloud/client'
import type { BackendSnapshot, InitPayload, SyncBackend } from './engine'

export class CloudSyncBackend implements SyncBackend {
  constructor(private readonly cloud: CloudClient) {}

  async ensureWorkspace(name: string): Promise<string> {
    const workspaces = (await this.cloud.request('/api/v1/workspaces')) as { id: string; name: string }[]
    const existing = workspaces.find((workspace) => workspace.name === name)
    if (existing) return existing.id
    const created = (await this.cloud.request('/api/v1/workspaces', {
      method: 'POST',
      body: { name },
    })) as { id: string }
    return created.id
  }

  async listSnapshots(workspaceId: string): Promise<BackendSnapshot[]> {
    const response = (await this.cloud.request(`/api/v1/workspaces/${workspaceId}/snapshots?limit=200`)) as {
      items: BackendSnapshot[]
    }
    return response.items
  }

  async latest(workspaceId: string, withManifest = false): Promise<BackendSnapshot | null> {
    try {
      return (await this.cloud.request(
        `/api/v1/workspaces/${workspaceId}/snapshots/latest${withManifest ? '?withManifest=true' : ''}`,
      )) as BackendSnapshot
    } catch (error) {
      if (error instanceof CloudError && error.status === 404) return null
      throw error
    }
  }

  async init(
    workspaceId: string,
    payload: InitPayload,
  ): Promise<{ snapshotId: string; version: number; uploadUrl: string }> {
    return (await this.cloud.request(`/api/v1/workspaces/${workspaceId}/snapshots:init`, {
      method: 'POST',
      body: {
        baseVersion: payload.baseVersion,
        sizeBytes: payload.sizeBytes,
        fileCount: payload.fileCount,
        manifestDigest: payload.manifestDigest,
        comment: payload.comment,
        manifest: payload.manifest,
      },
      timeoutMs: 60_000,
    })) as { snapshotId: string; version: number; uploadUrl: string }
  }

  async upload(uploadUrl: string, filePath: string): Promise<void> {
    // 预签名直传对象存储（不经 API）；Node fetch 需要 duplex: 'half' 才能发送流，
    // 且必须显式带 Content-Length（否则 MinIO 返回 411）
    const size = (await stat(filePath)).size
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: createReadStream(filePath) as unknown as string,
      headers: { 'content-type': 'application/zip', 'content-length': String(size) },
      signal: AbortSignal.timeout(3600_000),
      duplex: 'half',
    } as RequestInit)
    if (!response.ok) throw new Error(`快照上传失败（HTTP ${response.status}）`)
  }

  async complete(snapshotId: string, digest: string): Promise<BackendSnapshot> {
    return (await this.cloud.request(`/api/v1/snapshots/${snapshotId}:complete`, {
      method: 'POST',
      body: { digest },
      timeoutMs: 120_000,
    })) as BackendSnapshot
  }

  async downloadUrl(snapshotId: string): Promise<{ url: string; digest: string | null; version: number }> {
    return (await this.cloud.request(`/api/v1/snapshots/${snapshotId}/download-url`)) as {
      url: string
      digest: string | null
      version: number
    }
  }

  async download(url: string): Promise<Buffer> {
    const response = await fetch(url, { signal: AbortSignal.timeout(600_000) })
    if (!response.ok) throw new Error(`快照下载失败（HTTP ${response.status}）`)
    return Buffer.from(await response.arrayBuffer())
  }

  async pin(snapshotId: string): Promise<void> {
    await this.cloud.request(`/api/v1/snapshots/${snapshotId}:pin`, { method: 'POST' })
  }

  async remove(snapshotId: string): Promise<void> {
    await this.cloud.request(`/api/v1/snapshots/${snapshotId}`, { method: 'DELETE' })
  }

  async quota(workspaceId: string): Promise<{ usedBytes: number; limitBytes: number }> {
    const quota = (await this.cloud.request(`/api/v1/workspaces/${workspaceId}/quota`)) as {
      usedBytes: number
      limitBytes: number
    }
    return { usedBytes: quota.usedBytes, limitBytes: quota.limitBytes }
  }
}
