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
    <div className="rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm">
      <div className="mb-2 font-medium text-sky-900">{request.question}</div>
      <div className="flex flex-col gap-2">
        {request.options.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => onAnswer(option.value)}
            className={`rounded-lg border px-3 py-2 text-left text-xs ${
              option.value === request.recommended
                ? 'border-sky-400 bg-white ring-1 ring-sky-300'
                : 'border-neutral-200 bg-white hover:bg-neutral-50'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium">{option.label}</span>
              {option.value === request.recommended && (
                <span className="rounded bg-sky-200 px-1.5 py-0.5 text-[10px] text-sky-900">{t('推荐')}</span>
              )}
            </div>
            {option.description && <div className="mt-0.5 text-neutral-500">{option.description}</div>}
          </button>
        ))}
      </div>
      {request.allowFreeText && (
        <div className="mt-2 flex gap-2">
          <input
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            placeholder={t("或输入自定义内容…")}
            className="flex-1 rounded-lg border border-neutral-300 px-2 py-1.5 text-xs"
          />
          <button
            type="button"
            onClick={() => onAnswer(freeText.trim())}
            disabled={!freeText.trim()}
            className="rounded-lg bg-sky-700 px-3 py-1.5 text-xs text-white disabled:opacity-40"
          >
            {t('提交')}
          </button>
        </div>
      )}
      <button type="button" onClick={() => onAnswer('')} className="mt-2 text-[11px] text-neutral-500 hover:underline">
        {t('跳过（取消本次提问）')}
      </button>
    </div>
  )
}
