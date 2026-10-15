import { t } from '../i18n'
export type AppTab =
  | 'chat'
  | 'market'
  | 'models'
  | 'skills'
  | 'mcp'
  | 'workspace'
  | 'sync'
  | 'stats'
  | 'permissions'
  | 'about'

export const APP_TABS: { id: AppTab; label: string }[] = [
  { id: 'chat', label: t('对话') },
  { id: 'market', label: t('市场') },
  { id: 'models', label: t('模型配置') },
  { id: 'skills', label: t('Skill 配置') },
  { id: 'mcp', label: t('MCP 配置') },
  { id: 'workspace', label: t('工作空间') },
  { id: 'sync', label: t('云同步') },
  { id: 'stats', label: t('用量统计') },
  { id: 'permissions', label: t('权限与审计') },
  { id: 'about', label: t('关于') },
]

interface Props {
  active: AppTab
  onChange: (tab: AppTab) => void
}

export default function TopTabs({ active, onChange }: Props) {
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
    </nav>
  )
}
