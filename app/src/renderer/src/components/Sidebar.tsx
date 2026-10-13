import type { SessionMetaView, UsageStatsView, WorkspaceInfoView } from '@shared/ipc'

interface Props {
  sessions: SessionMetaView[]
  currentId: string | null
  usage: UsageStatsView | null
  workspace: WorkspaceInfoView | null
  onSelect: (id: string) => void
  onNew: () => void
  onOpenSettings: () => void
}

export default function Sidebar({ sessions, currentId, usage, workspace, onSelect, onNew, onOpenSettings }: Props) {
  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-neutral-200 bg-white">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold tracking-wide">hu-agent</span>
        <button
          type="button"
          onClick={onNew}
          className="rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700"
        >
          ＋ 新会话
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => onSelect(session.id)}
            className={`mb-1 w-full truncate rounded-md px-3 py-2 text-left text-sm ${
              session.id === currentId ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'
            }`}
          >
            <div className="truncate">{session.title}</div>
            <div className={`text-[11px] ${session.id === currentId ? 'text-neutral-300' : 'text-neutral-400'}`}>
              {session.messageCount} 条消息
            </div>
          </button>
        ))}
      </div>

      <div className="border-t border-neutral-200 px-4 py-3 text-[11px] text-neutral-500">
        {usage && (
          <div className="mb-2">
            累计 {usage.calls} 次调用 / {usage.inputTokens + usage.outputTokens} tokens
            {usage.errors > 0 ? ` / ${usage.errors} 次失败` : ''}
          </div>
        )}
        {workspace && <div className="mb-2 truncate" title={workspace.root}>工作空间：{workspace.root}</div>}
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-md border border-neutral-300 px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
        >
          模型设置
        </button>
      </div>
    </aside>
  )
}
