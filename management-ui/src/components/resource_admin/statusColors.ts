/** 市场资源状态 → AntD Tag 颜色（Skill / MCP 管理页共用，design 7.2）。 */

export const RESOURCE_STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  pending: 'processing',
  published: 'success',
  rejected: 'error',
  superseded: 'default',
  delisted: 'warning',
  disabled: 'error',
  deleted: 'default',
  revoked: 'error',
}
