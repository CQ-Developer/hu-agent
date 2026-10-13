/** 主进程与渲染进程之间的接口契约（类型化 IPC）。 */

import type { AgentEvent } from './events'

export interface ModelCapabilitiesView {
  tools: boolean
  vision?: boolean
  contextWindow: number
  maxOutput?: number
}

export interface ModelEntryView {
  name: string
  roles?: ('primary' | 'fast')[]
  capabilities: ModelCapabilitiesView
}

export interface ProviderView {
  id: string
  type: 'openai-compatible'
  baseUrl: string
  apiKeyRef: string | null
  models: ModelEntryView[]
}

export interface SettingsView {
  providers: ProviderView[]
  defaults: { primary: string; fast?: string }
  secretsConfigured: Record<string, boolean>
}

export interface SaveProviderInput {
  id: string
  baseUrl: string
  models: ModelEntryView[]
  /** 明文密钥只在 IPC 中传递一次，主进程立即加密存储 */
  apiKey?: string | null
}

export interface SessionMetaView {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export type SessionItemView =
  | { kind: 'message'; id: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string }
  | {
      kind: 'tool'
      id: string
      name: string
      input: unknown
      status?: 'ok' | 'error' | 'denied' | 'timeout'
      output?: string
      durationMs?: number
      truncated?: boolean
      artifactPath?: string
      createdAt: string
    }

export interface UsageStatsView {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  byModel: Record<string, { calls: number; inputTokens: number; outputTokens: number }>
}

export interface WorkspaceInfoView {
  id: string
  root: string
}

export interface HuAgentApi {
  getVersion(): Promise<string>
  settings: {
    get(): Promise<SettingsView>
    saveProvider(input: SaveProviderInput): Promise<SettingsView>
    removeProvider(id: string): Promise<SettingsView>
    setDefault(role: 'primary' | 'fast', target: string): Promise<SettingsView>
  }
  sessions: {
    list(): Promise<SessionMetaView[]>
    create(): Promise<SessionMetaView>
    items(sessionId: string): Promise<SessionItemView[]>
    rename(sessionId: string, title: string): Promise<void>
  }
  agent: {
    send(sessionId: string, text: string): Promise<void>
    cancel(sessionId: string): Promise<void>
    onEvent(listener: (event: AgentEvent) => void): () => void
  }
  usage: {
    stats(): Promise<UsageStatsView>
  }
  workspace: {
    info(): Promise<WorkspaceInfoView>
  }
}
