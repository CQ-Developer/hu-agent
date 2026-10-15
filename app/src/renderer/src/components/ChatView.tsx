import { useEffect, useRef } from 'react'

import type { ApprovalRequestView, GuideRequestView } from '@shared/events'
import type { ModelOptionView, SessionItemView, SessionOptionsView, SessionUsageView } from '@shared/ipc'

import ApprovalCard from './ApprovalCard'
import Composer from './Composer'
import GuideCard from './GuideCard'
import MessageBubble from './MessageBubble'
import ToolCard from './ToolCard'
import { t } from '../i18n'

interface Props {
  items: SessionItemView[]
  streamingText: string
  streamingReasoning: string
  running: boolean
  error: string | null
  models: ModelOptionView[]
  options: SessionOptionsView | null
  stats: SessionUsageView | null
  approval: ApprovalRequestView | null
  guide: GuideRequestView | null
  onOptionsChange: (options: SessionOptionsView) => void
  onSend: (text: string) => void
  onStop: () => void
  onDecideApproval: (choice: 'allow_once' | 'allow_session' | 'allow_always' | 'deny') => void
  onAnswerGuide: (value: string) => void
}

export default function ChatView({
  items,
  streamingText,
  streamingReasoning,
  running,
  error,
  models,
  options,
  stats,
  approval,
  guide,
  onOptionsChange,
  onSend,
  onStop,
  onDecideApproval,
  onAnswerGuide,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [items, streamingText, streamingReasoning, approval, guide, error])

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {items.length === 0 && !streamingText && !streamingReasoning && (
          <div className="mt-16 text-center text-sm text-fg-subtle">
            {t('新建会话后，描述一个任务试试：比如「读取 package.json 并总结项目脚本」')}
          </div>
        )}
        {items.map((item) =>
          item.kind === 'message' ? (
            item.text || item.reasoning ? (
              <MessageBubble key={item.id} role={item.role} text={item.text} reasoning={item.reasoning} />
            ) : null
          ) : (
            <ToolCard key={item.id} item={item} />
          ),
        )}
        {(running || streamingText || streamingReasoning) && (
          <MessageBubble role="assistant" text={streamingText} reasoning={streamingReasoning} streaming />
        )}
        {error && <div className="glass rounded-field bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
        <div ref={bottomRef} />
      </div>

      {(approval || guide) && (
        <div className="px-6 pb-2">
          {approval && <ApprovalCard request={approval} onDecide={onDecideApproval} />}
          {guide && <GuideCard request={guide} onAnswer={onAnswerGuide} />}
        </div>
      )}

      <Composer
        running={running}
        models={models}
        options={options}
        stats={stats}
        onOptionsChange={onOptionsChange}
        onSend={onSend}
        onStop={onStop}
      />
    </main>
  )
}
