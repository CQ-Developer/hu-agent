/**
 * 服务端业务码 → 本地化文案（design 6.9.1 / 5.13）：
 * 服务端只保证业务码稳定，文案由客户端本地化，避免服务端语言与界面语言不一致。
 */

import { lookup, type Locale } from './index'

/** 业务码 → 中文消息键（中文即键，英文见 en-US 词典） */
export const ERROR_CODE_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: '登录状态已失效，请重新登录',
  REFRESH_REVOKED: '会话已被服务端撤销，请重新登录',
  FORBIDDEN: '没有权限执行该操作',
  NOT_FOUND: '资源不存在或无权访问',
  CONFLICT: '操作冲突，请刷新后重试',
  VERSION_CONFLICT: '版本冲突：服务端已有更新的版本，请先同步',
  NAME_CONFLICT: '名称已存在，请换一个',
  VALIDATION_FAILED: '请求参数不合法',
  PACKAGE_INVALID: '包校验失败，已拒绝安装',
  QUOTA_EXCEEDED: '存储配额已满，请清理或申请扩容',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  ACCOUNT_DISABLED: '账号已被禁用，请联系管理员',
  CLIENT_TOO_OLD: '客户端版本过旧，请升级后再试',
  METHOD_NOT_ALLOWED: '服务端不支持该操作',
  INTERNAL: '服务端内部错误，请稍后重试',
}

/**
 * 本地化服务端错误（design 6.9.1 / 5.13）：
 * - 中文界面：优先用服务端原文（服务端本就是中文且更具体：如「刷新令牌已失效」），
 *   服务端未给文案时回退到业务码文案；
 * - 其他语言：用本语言业务码文案，不把服务端中文混入界面。
 */
export function localizeServerError(locale: Locale, code: string, serverMessage: string): string {
  const key = ERROR_CODE_MESSAGES[code]
  const translated = key ? lookup(locale, key) : ''
  if (locale === 'zh-CN') return serverMessage || translated
  return translated || serverMessage
}
