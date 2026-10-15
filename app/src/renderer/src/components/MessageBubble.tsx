import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import { t } from '../i18n'

interface Props {
  role: 'user' | 'assistant' | 'system'
  text: string
  /** 思考内容（design 5.2.6） */
  reasoning?: string
  /** 流式进行中：思考块默认展开 */
  streaming?: boolean
}

export default function MessageBubble({ role, text, reasoning, streaming = false }: Props) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-card rounded-br-md bg-accent px-4 py-2.5 text-sm text-accent-contrast shadow-[0_12px_28px_-10px_var(--ui-accent-ring)]">
          {text}
        </div>
      </div>
    )
  }

  const hasText = text.trim().length > 0

  return (
    <div className="flex justify-start">
      <div className="glass max-w-[85%] rounded-card rounded-bl-md px-4 py-2.5 text-sm">
        {reasoning && (
          <details
            open={streaming}
            className="mb-2 rounded-lg border border-warning bg-warning-soft/60 px-3 py-2"
          >
            <summary className="cursor-pointer select-none text-xs font-medium text-warning">
              {streaming ? t('思考中…') : t('思考过程')}
            </summary>
            <div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-warning/80">
              {reasoning}
            </div>
          </details>
        )}
        {hasText && (
          <div className="markdown">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{text}</ReactMarkdown>
          </div>
        )}
        {!hasText && streaming && !reasoning && <div className="text-xs text-fg-subtle">{t('思考中…')}</div>}
      </div>
    </div>
  )
}
