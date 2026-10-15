import { t } from '../i18n'

export type AppTab = 'chat' | 'market'

export const APP_TABS: { id: AppTab; label: string }[] = [
  { id: 'chat', label: t('对话') },
  { id: 'market', label: t('市场') },
]

interface Props {
  active: AppTab
  onChange: (tab: AppTab) => void
  onOpenSettings: () => void
}

/**
 * 顶部导航（导航重构 2026-10-15）：只保留「对话 / 市场」，其余入口收进「设置」面。
 */
export default function TopTabs({ active, onChange, onOpenSettings }: Props) {
  return (
    <nav className="glass flex shrink-0 items-center gap-1 overflow-x-auto rounded-none px-3 shadow-none">
      {APP_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`whitespace-nowrap rounded-chip px-3 py-2 text-small transition duration-200 ease-standard ${
            tab.id === active ? 'bg-surface-3 font-medium text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
          }`}
        >
          {tab.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onOpenSettings}
        title={t('设置')}
        aria-label={t('设置')}
        className="ui-icon-btn ml-auto !h-8 !w-8 text-caption"
      >
        ⚙
      </button>
    </nav>
  )
}
