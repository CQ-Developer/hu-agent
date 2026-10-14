import { t } from '../i18n'
/** 模型调用错误分类与重试判断（design 5.2.4）。 */

export type ModelErrorKind = 'network' | 'timeout' | 'rate_limit' | 'auth' | 'bad_request' | 'server' | 'unknown'

export class ModelError extends Error {
  readonly kind: ModelErrorKind
  readonly status?: number

  constructor(kind: ModelErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'ModelError'
    this.kind = kind
    this.status = status
  }

  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'rate_limit' || this.kind === 'server'
  }
}

export function classifyHttpError(status: number, body: string): ModelError {
  const detail = body.length > 500 ? `${body.slice(0, 500)}…` : body
  if (status === 401 || status === 403) return new ModelError('auth', t('认证失败（{status}）：请检查 API Key', { status }), status)
  if (status === 429) return new ModelError('rate_limit', t('请求被限流（429）'), status)
  if (status === 408 || status === 504) return new ModelError('timeout', t('请求超时（{status}）', { status }), status)
  if (status >= 500) return new ModelError('server', t('模型服务错误（{status}）：{detail}', { status, detail }), status)
  return new ModelError('bad_request', t('请求错误（{status}）：{detail}', { status, detail }), status)
}

export function classifyThrown(error: unknown): ModelError {
  if (error instanceof ModelError) return error
  if (error instanceof Error) {
    if (error.name === 'AbortError') return new ModelError('timeout', t('请求已取消'))
    if (error.name === 'TimeoutError') return new ModelError('timeout', t('请求超时'))
    const cause = (error as Error & { cause?: unknown }).cause
    const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : ''
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'EAI_AGAIN') {
      return new ModelError('network', t('无法连接模型服务（{code}）', { code }))
    }
    if (error.message.includes('fetch failed')) return new ModelError('network', t('无法连接模型服务：{message}', { message: error.message }))
    return new ModelError('unknown', error.message)
  }
  return new ModelError('unknown', String(error))
}
