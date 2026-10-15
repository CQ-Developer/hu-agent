import type { ApprovalRequestView } from '@shared/events'
import { t } from '../i18n'

interface Props {
  request: ApprovalRequestView
  onDecide: (choice: 'allow_once' | 'allow_session' | 'allow_always' | 'deny') => void
}

const CATEGORY_LABEL: Record<ApprovalRequestView['category'], string> = {
  read: t('读取'),
  write: t('写入'),
  exec: t('执行命令'),
  interact: t('交互'),
  mcp: 'MCP',
}

export default function ApprovalCard({ request, onDecide }: Props) {
  return (
    <div className="glass rounded-card border-0 bg-warning-soft px-4 py-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-warning">{t('需要授权')}</span>
        <span className="rounded-chip bg-warning-soft px-2 py-0.5 text-[11px] text-warning">
          {request.toolName} · {CATEGORY_LABEL[request.category]}
        </span>
      </div>
      <div className="mb-2 text-xs text-warning/80">{t('工作空间外的操作需要你确认。')}</div>
      <pre className="mb-3 max-h-40 overflow-auto rounded-field bg-surface/70 p-2 text-xs whitespace-pre-wrap">
        {request.command ?? request.paths.join('\n')}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => onDecide('allow_once')} className="ui-btn ui-btn-primary px-3.5 py-1.5 text-caption">
          {t('允许一次')}
        </button>
        <button type="button" onClick={() => onDecide('allow_session')} className="ui-btn ui-btn-glass px-3.5 py-1.5 text-caption">
          {t('本会话允许')}
        </button>
        <button
          type="button"
          onClick={() => onDecide('allow_always')}
          title={request.scopeHint}
          className="ui-btn ui-btn-glass px-3.5 py-1.5 text-caption"
        >
          {t('始终允许')}
        </button>
        <button type="button" onClick={() => onDecide('deny')} className="ui-btn ui-btn-danger ml-auto px-3.5 py-1.5 text-caption">
          {t('拒绝')}
        </button>
      </div>
      <div className="mt-2 text-[11px] text-warning/80">{request.scopeHint}</div>
    </div>
  )
}
