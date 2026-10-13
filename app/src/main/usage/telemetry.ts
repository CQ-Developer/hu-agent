/** 上报事件接口（design 5.10）：Loop 只依赖该最小接口，由 ipc 组装工作空间上下文。 */

export interface TelemetryInput {
  sessionId: string
  provider: string
  model: string
  purpose: 'primary' | 'fast'
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  durationMs?: number
  status: 'success' | 'error'
  errorCode?: string
}

export interface TelemetrySink {
  record(input: TelemetryInput): Promise<void>
}
