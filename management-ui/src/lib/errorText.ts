/**
 * 错误文案（design 6.9.1 / 7.1）：服务端返回业务码，管理台按码本地化，
 * 未知码回退服务端原文（便于排障）。
 */

import { ApiError } from '../api/client'

const ERROR_KEYS: Record<string, string> = {
  UNAUTHENTICATED: 'errors.UNAUTHENTICATED',
  REFRESH_REVOKED: 'errors.REFRESH_REVOKED',
  FORBIDDEN: 'errors.FORBIDDEN',
  NOT_FOUND: 'errors.NOT_FOUND',
  CONFLICT: 'errors.CONFLICT',
  VERSION_CONFLICT: 'errors.VERSION_CONFLICT',
  NAME_CONFLICT: 'errors.NAME_CONFLICT',
  VALIDATION_FAILED: 'errors.VALIDATION_FAILED',
  PACKAGE_INVALID: 'errors.PACKAGE_INVALID',
  QUOTA_EXCEEDED: 'errors.QUOTA_EXCEEDED',
  RATE_LIMITED: 'errors.RATE_LIMITED',
  ACCOUNT_DISABLED: 'errors.ACCOUNT_DISABLED',
  CLIENT_TOO_OLD: 'errors.CLIENT_TOO_OLD',
  METHOD_NOT_ALLOWED: 'errors.METHOD_NOT_ALLOWED',
  INTERNAL: 'errors.INTERNAL',
}

type Translate = (key: string, options?: Record<string, unknown>) => string

export function errorText(cause: unknown, t: Translate): string {
  if (cause instanceof ApiError) {
    const key = ERROR_KEYS[cause.code]
    const suffix = cause.traceId ? ` (${cause.traceId.slice(0, 8)})` : ''
    if (key) return `${t(key)}${suffix}`
    return `${cause.message}${suffix}`
  }
  return cause instanceof Error ? cause.message : String(cause)
}
