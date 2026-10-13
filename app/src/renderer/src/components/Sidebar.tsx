import { useState } from 'react'

import type { SessionMetaView, SessionSearchHitView, WorkspaceInfoView } from '@shared/ipc'

interface Props {
  sessions: SessionMetaView[]
  currentId: string | null
  workspace: WorkspaceInfoView | null
  workspaces: WorkspaceInfoView[]
  searchHits: SessionSearchHitView[]
  onSelect: (id: string) => void
  onNew: () => void
  onOpenProfile: () => void
  onSwitchWorkspace: (id: string) => void
  onPickWorkspace: () => void
  onSearch: (query: string) => void
  onOpenHit: (sessionId: string) => void
}

export default function Sidebar({
  sessions,
  currentId,
  workspace,
  workspaces,
  searchHits,
  onSelect,
  onNew,
  onOpenProfile,
  onSwitchWorkspace,
  onPickWorkspace,
  onSearch,
  onOpenHit,
}: Props) {
  const [query, setQuery] = useState('')
  const searching = query.trim().length > 0

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

      <div className="flex items-center gap-1 px-3 pb-2">
        <select
          value={workspace?.id ?? ''}
          onChange={(event) => onSwitchWorkspace(event.target.value)}
          className="min-w-0 flex-1 truncate rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs"
          title={workspace?.root}
        >
          {workspaces.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onPickWorkspace}
          title="打开其他目录作为工作空间"
          className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100"
        >
          打开目录
        </button>
      </div>

      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            onSearch(event.target.value)
          }}
          placeholder="搜索会话内容…"
          className="w-full rounded-md border border-neutral-300 px-2 py-1 text-xs"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {searching
          ? searchHits.map((hit) => (
              <button
                key={`${hit.sessionId}-${hit.snippet.slice(0, 12)}`}
                type="button"
                onClick={() => onOpenHit(hit.sessionId)}
                className="mb-1 w-full rounded-md px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-100"
              >
                <div className="truncate font-medium">{hit.title}</div>
                <div className="line-clamp-2 text-[11px] text-neutral-400">{hit.snippet}</div>
              </button>
            ))
          : sessions.map((session) => (
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
        {searching && searchHits.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-neutral-400">没有匹配的会话内容</div>
        )}
      </div>

      <div className="border-t border-neutral-200 p-2">
        <button
          type="button"
          onClick={onOpenProfile}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-neutral-200 text-xs">👤</span>
          <span className="flex-1">个人中心</span>
          <span className="text-[10px] text-neutral-400">未登录</span>
        </button>
      </div>
    </aside>
  )
}
