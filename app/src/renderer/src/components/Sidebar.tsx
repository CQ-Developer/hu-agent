import { useState } from 'react'

import type { SessionMetaView, SessionSearchHitView, WorkspaceInfoView } from '@shared/ipc'
import { t } from '../i18n'

interface Props {
  sessions: SessionMetaView[]
  currentId: string | null
  workspace: WorkspaceInfoView | null
  workspaces: WorkspaceInfoView[]
  searchHits: SessionSearchHitView[]
  accountLabel: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
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
  accountLabel,
  onSelect,
  onDelete,
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
    <aside className="glass flex h-full w-72 shrink-0 flex-col rounded-none shadow-none">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-sm font-semibold tracking-wide">hu-agent</span>
        <button
          type="button"
          onClick={onNew}
          className="ui-btn ui-btn-primary px-3.5 py-1.5 text-caption"
        >
          {t('＋ 新会话')}
        </button>
      </div>

      <div className="flex items-center gap-1 px-3 pb-2">
        <select
          value={workspace?.id ?? ''}
          onChange={(event) => onSwitchWorkspace(event.target.value)}
          className="min-w-0 flex-1 truncate rounded-md border border-line-strong bg-surface-2 px-2 py-1 text-xs"
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
          title={t("打开其他目录作为工作空间")}
          className="rounded-md border border-line-strong px-2 py-1 text-xs hover:bg-surface-2"
        >
          {t('打开目录')}
        </button>
      </div>

      <div className="px-3 pb-2">
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            onSearch(event.target.value)
          }}
          placeholder={t("搜索会话内容…")}
          className="w-full rounded-md border border-line-strong px-2 py-1 text-xs"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {searching
          ? searchHits.map((hit) => (
              <button
                key={`${hit.sessionId}-${hit.snippet.slice(0, 12)}`}
                type="button"
                onClick={() => onOpenHit(hit.sessionId)}
                className="mb-1 w-full rounded-md px-3 py-2 text-left text-xs text-fg hover:bg-surface-2"
              >
                <div className="truncate font-medium">{hit.title}</div>
                <div className="line-clamp-2 text-[11px] text-fg-subtle">{hit.snippet}</div>
              </button>
            ))
          : sessions.map((session) => (
              <div key={session.id} className="group relative mb-1">
                <button
                  type="button"
                  onClick={() => onSelect(session.id)}
                  className={`w-full truncate rounded-md py-2 pl-3 pr-8 text-left text-sm ${
                    session.id === currentId
                      ? 'bg-accent-soft text-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.35),inset_0_0_0_1px_var(--ui-accent-ring)]'
                      : 'text-fg hover:bg-surface-2'
                  }`}
                >
                  <div className="truncate">{session.title}</div>
                  <div className={`text-[11px] ${session.id === currentId ? 'text-fg-subtle' : 'text-fg-subtle'}`}>
                    {session.messageCount} {t('条消息')}
                  </div>
                </button>
                <button
                  type="button"
                  title={t('删除会话')}
                  aria-label={t('删除会话')}
                  onClick={(event) => {
                    event.stopPropagation()
                    onDelete(session.id)
                  }}
                  className={`absolute right-1.5 top-1/2 hidden -translate-y-1/2 rounded px-1.5 py-1 text-xs group-hover:block ${
                    session.id === currentId ? 'text-fg-subtle hover:bg-surface-2/20' : 'text-fg-subtle hover:bg-surface-3'
                  }`}
                >
                  ×
                </button>
              </div>
            ))}
        {searching && searchHits.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-fg-subtle">{t('没有匹配的会话内容')}</div>
        )}
      </div>

      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={onOpenProfile}
          className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-fg hover:bg-surface-2"
        >
          <span className="grid h-6 w-6 place-items-center rounded-full bg-surface-3 text-xs">👤</span>
          <span className="flex-1">{t('个人中心')}</span>
          <span className="max-w-[110px] truncate text-[10px] text-fg-subtle">{accountLabel}</span>
        </button>
      </div>
    </aside>
  )
}
