import type { SessionItemView } from '@shared/ipc'
import { t } from '../i18n'

type ToolItem = Extract<SessionItemView, { kind: 'tool' }>

const STATUS_STYLE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  error: 'bg-rose-100 text-rose-700',
  timeout: 'bg-amber-100 text-amber-700',
  denied: 'bg-neutral-200 text-neutral-700',
}

export default function ToolCard({ item }: { item: ToolItem }) {
  const status = item.status ?? 'running'
  const badge = STATUS_STYLE[status] ?? 'bg-neutral-100 text-neutral-500'

  return (
    <details className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm">
      <summary className="flex cursor-pointer items-center gap-2">
        <span className="font-mono text-xs font-semibold text-neutral-800">{item.name}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] ${badge}`}>{status}</span>
        {typeof item.durationMs === 'number' && (
          <span className="text-[11px] text-neutral-400">{item.durationMs}ms</span>
        )}
        {item.truncated && <span className="text-[11px] text-amber-600">{t('已截断')}</span>}
      </summary>
      <div className="mt-2 space-y-2">
        <div>
          <div className="mb-1 text-[11px] text-neutral-400">{t('参数')}</div>
          <pre className="max-h-40 overflow-auto rounded bg-neutral-50 p-2 text-xs">{JSON.stringify(item.input, null, 2)}</pre>
        </div>
        {item.output !== undefined && (
          <div>
            <div className="mb-1 text-[11px] text-neutral-400">{t('输出')}</div>
            <pre className="max-h-72 overflow-auto rounded bg-neutral-50 p-2 text-xs whitespace-pre-wrap">{item.output}</pre>
          </div>
        )}
        {item.artifactPath && <div className="text-[11px] text-neutral-400">{t('全文：')}{item.artifactPath}</div>}
      </div>
    </details>
  )
}
