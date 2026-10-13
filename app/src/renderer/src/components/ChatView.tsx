import { useEffect, useRef } from 'react'

import type { SessionItemView } from '@shared/ipc'

import Composer from './Composer'
import MessageBubble from './MessageBubble'
import ToolCard from './ToolCard'

interface Props {
  items: SessionItemView[]
  streamingText: string
  running: boolean
  error: string | null
  onSend: (text: string) => void
  onStop: () => void
}

export default function ChatView({ items, streamingText, running, error, onSend, onStop }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streamingText, error])

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {items.length === 0 && !streamingText && (
          <div className="mt-16 text-center text-sm text-neutral-400">
            新建会话后，描述一个任务试试：比如「读取 package.json 并总结项目脚本」
          </div>
        )}
        {items.map((item) =>
          item.kind === 'message' ? (
            item.text ? (
              <MessageBubble key={item.id} role={item.role} text={item.text} />
            ) : null
          ) : (
            <ToolCard key={item.id} item={item} />
          ),
        )}
        {streamingText && <MessageBubble role="assistant" text={streamingText} />}
        {running && !streamingText && <div className="text-xs text-neutral-400">思考中…</div>}
        {error && <div className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}
        <div ref={bottomRef} />
      </div>
      <Composer running={running} onSend={onSend} onStop={onStop} />
    </main>
  )
}
