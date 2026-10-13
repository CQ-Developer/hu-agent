import ReactMarkdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

interface Props {
  role: 'user' | 'assistant' | 'system'
  text: string
}

export default function MessageBubble({ role, text }: Props) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm text-white">
          {text}
        </div>
      </div>
    )
  }

  return (
    <div className="flex justify-start">
      <div className="markdown max-w-[85%] rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-4 py-2.5 text-sm">
        <ReactMarkdown rehypePlugins={[rehypeSanitize]}>{text}</ReactMarkdown>
      </div>
    </div>
  )
}
