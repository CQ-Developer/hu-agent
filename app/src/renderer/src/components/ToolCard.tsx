import type { SessionItemView } from '@shared/ipc'
import { t } from '../i18n'

type ToolItem = Extract<SessionItemView, { kind: 'tool' }>

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-success-soft text-success',
  error: 'bg-danger-soft text-danger',
  timeout: 'bg-warning-soft text-warning',
  denied: 'bg-surface-3 text-fg',
}

export default function ToolCard({ item }: { item: ToolItem }) {
  const status = item.status ?? 'running'
  const badge = STATUS_STYLE[status] ?? 'bg-surface-2 text-fg-muted'

  return (
    <details className="glass rounded-field px-3 py-2 text-sm">
      <summary className="flex cursor-pointer items-center gap-2">
        <span className="font-mono text-xs font-semibold text-fg">{item.name}</span>
        <span className={`rounded-chip px-2 py-0.5 text-[11px] ${badge}`}>{status}</span>
        {typeof item.durationMs === 'number' && (
          <span className="text-[11px] text-fg-subtle">{item.durationMs}ms</span>
        )}
        {item.truncated && <span className="text-[11px] text-warning">{t('已截断')}</span>}
      </summary>
      <div className="mt-2 space-y-2">
        <div>
          <div className="mb-1 text-[11px] text-fg-subtle">{t('参数')}</div>
          <pre className="max-h-40 overflow-auto rounded bg-surface p-2 text-xs">{JSON.stringify(item.input, null, 2)}</pre>
        </div>
        {item.output !== undefined && (
          <div>
            <div className="mb-1 text-[11px] text-fg-subtle">{t('输出')}</div>
            <pre className="max-h-72 overflow-auto rounded bg-surface p-2 text-xs whitespace-pre-wrap">{item.output}</pre>
          </div>
        )}
        {item.artifactPath && <div className="text-[11px] text-fg-subtle">{t('全文：')}{item.artifactPath}</div>}
      </div>
    </details>
  )
}
