import { useState } from 'react'

import type { ModelOptionView, ReasoningEffortView, SessionOptionsView, SessionUsageView } from '@shared/ipc'
import { t } from '../i18n'

interface Props {
  running: boolean
  models: ModelOptionView[]
  options: SessionOptionsView | null
  stats: SessionUsageView | null
  onOptionsChange: (options: SessionOptionsView) => void
  onSend: (text: string) => void
  onStop: () => void
}

const EFFORT_LABELS: Record<ReasoningEffortView, string> = {
  off: t('思考：关闭'),
  low: t('思考：低'),
  medium: t('思考：中'),
  high: t('思考：高'),
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export default function Composer({ running, models, options, stats, onOptionsChange, onSend, onStop }: Props) {
  const [text, setText] = useState('')
  const selected = models.find((model) => model.target === options?.model) ?? models[0]
  const effortDisabled = !selected?.reasoningEffort

  const submit = (): void => {
    const value = text.trim()
    if (!value || running) return
    onSend(value)
    setText('')
  }

  return (
    <div className="border-t border-neutral-200 bg-white px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-neutral-500">
        <select
          value={selected?.target ?? ''}
          onChange={(event) => options && onOptionsChange({ ...options, model: event.target.value })}
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700"
          title={t("本会话使用的模型")}
        >
          {models.length === 0 && <option value="">{t('（未配置模型）')}</option>}
          {models.map((model) => (
            <option key={model.target} value={model.target}>
              {model.providerId} / {model.name}
            </option>
          ))}
        </select>

        <select
          value={options?.reasoningEffort ?? 'off'}
          disabled={effortDisabled}
          onChange={(event) =>
            options && onOptionsChange({ ...options, reasoningEffort: event.target.value as ReasoningEffortView })
          }
          className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 disabled:opacity-40"
          title={effortDisabled ? t('当前模型未声明支持思考强度（可在模型设置中开启）') : t('思考强度')}
        >
          {(['off', 'low', 'medium', 'high'] as const).map((level) => (
            <option key={level} value={level}>
              {EFFORT_LABELS[level]}
            </option>
          ))}
        </select>

        {stats && (
          <span className="ml-auto tabular-nums">
            {t('输入')} {formatTokens(stats.inputTokens)} {t('· 输出')} {formatTokens(stats.outputTokens)} {t('· 缓存命中')}{' '}
            {Math.round(stats.cacheHitRate * 100)}{t('% · 上下文剩余')} {Math.round(stats.contextRemainingPercent)}%
          </span>
        )}
      </div>

      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
          rows={3}
          placeholder={t("描述你的任务…（Enter 发送，Shift+Enter 换行）")}
          className="min-h-[64px] flex-1 resize-none rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500"
        />
        {running ? (
          <button
            type="button"
            onClick={onStop}
            className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white hover:bg-rose-500"
          >
            {t('停止')}
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim()}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('发送')}
          </button>
        )}
      </div>
    </div>
  )
}
