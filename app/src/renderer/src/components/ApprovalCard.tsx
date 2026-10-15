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
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-medium text-amber-800">{t('需要授权')}</span>
        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[11px] text-amber-900">
          {request.toolName} · {CATEGORY_LABEL[request.category]}
        </span>
      </div>
      <div className="mb-2 text-xs text-amber-900/80">{t('工作空间外的操作需要你确认。')}</div>
      <pre className="mb-3 max-h-40 overflow-auto rounded bg-white/70 p-2 text-xs whitespace-pre-wrap">
        {request.command ?? request.paths.join('\n')}
      </pre>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => onDecide('allow_once')} className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700">
          {t('允许一次')}
        </button>
        <button type="button" onClick={() => onDecide('allow_session')} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs hover:bg-neutral-100">
          {t('本会话允许')}
        </button>
        <button type="button" onClick={() => onDecide('allow_always')} title={request.scopeHint} className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs hover:bg-neutral-100">
          {t('始终允许')}
        </button>
        <button type="button" onClick={() => onDecide('deny')} className="ml-auto rounded-md bg-rose-600 px-3 py-1.5 text-xs text-white hover:bg-rose-500">
          {t('拒绝')}
        </button>
      </div>
      <div className="mt-2 text-[11px] text-amber-700/80">{request.scopeHint}</div>
    </div>
  )
}
