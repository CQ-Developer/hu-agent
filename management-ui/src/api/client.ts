/**
 * API 客户端占位：阶段 0 直接请求 /api/v1/system/health。
 * 阶段 4/5 接入由 openapi/openapi.json 生成的类型化客户端（design 6.9）。
 */

export interface ErrorPayload {
  code: string
  message: string
  details?: Record<string, unknown>
  traceId?: string
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  })

  if (!response.ok) {
    let payload: ErrorPayload | null = null
    try {
      payload = (await response.json()) as ErrorPayload
    } catch {
      // 非 JSON 错误体，保持 null
    }
    const suffix = payload?.code ? `（${payload.code} / ${payload.traceId ?? '-'}）` : ''
    throw new Error(`${response.status} ${response.statusText}${suffix}`)
  }

  return (await response.json()) as T
}

export interface HealthResponse {
  status: string
  time: string
}

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/api/v1/system/health')
}
