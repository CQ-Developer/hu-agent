import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

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
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm text-white">
          {text}
        </div>
      </div>
    )
  }

  const hasText = text.trim().length > 0

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-4 py-2.5 text-sm">
        {reasoning && (
          <details
            open={streaming}
            className="mb-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2"
          >
            <summary className="cursor-pointer select-none text-xs font-medium text-amber-700">
              {streaming ? '思考中…' : '思考过程'}
            </summary>
            <div className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs leading-relaxed text-amber-900/80">
              {reasoning}
            </div>
          </details>
        )}
        {hasText && (
          <div className="markdown">
            <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{text}</ReactMarkdown>
          </div>
        )}
        {!hasText && streaming && !reasoning && <div className="text-xs text-neutral-400">思考中…</div>}
      </div>
    </div>
  )
}
