import { useState } from 'react'

import type { GuideRequestView } from '@shared/events'
import { t } from '../i18n'

interface Props {
  request: GuideRequestView
  onAnswer: (value: string) => void
}

export default function GuideCard({ request, onAnswer }: Props) {
  const [freeText, setFreeText] = useState('')

  return (
    <div className="glass rounded-card bg-info-soft px-4 py-3 text-sm">
      <div className="mb-2 font-medium text-info">{request.question}</div>
      <div className="flex flex-col gap-2">
        {request.options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onAnswer(option.value)}
            className={`rounded-field px-3 py-2 text-left text-xs transition duration-200 ease-standard ${
              option.value === request.recommended
                ? 'bg-surface-3 ring-1 ring-info'
                : 'bg-surface-2 hover:bg-surface-3'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{option.label}</span>
              {option.value === request.recommended && (
                <span className="rounded-chip bg-info-soft px-2 py-0.5 text-[10px] text-info">{t('推荐')}</span>
              )}
            </div>
            {option.description && <div className="mt-0.5 text-fg-muted">{option.description}</div>}
          </button>
        ))}
      </div>
      {request.allowFreeText && (
        <div className="mt-2 flex gap-2">
          <input
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder={t("或输入自定义内容…")}
            className="ui-field flex-1 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={() => onAnswer(freeText.trim())}
            disabled={!freeText.trim()}
            className="ui-btn ui-btn-primary px-3.5 py-1.5 text-caption disabled:opacity-40"
          >
            {t('提交')}
          </button>
        </div>
      )}
      <button type="button" onClick={() => onAnswer('')} className="mt-2 text-[11px] text-fg-muted hover:underline">
        {t('跳过（取消本次提问）')}
      </button>
    </div>
  )
}
