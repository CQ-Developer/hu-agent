/** 市场资源状态 → 界面文案（Skill 与 MCP 市场共用）。 */

import { t } from '../../i18n'

export const MARKET_STATE_LABEL: Record<string, string> = {
  active: t('正常'),
  delisted: t('已下架'),
  disabled: t('已停用'),
  revoked: t('版本已撤回'),
  not_found: t('已删除'),
  unknown: t('状态未知'),
}
