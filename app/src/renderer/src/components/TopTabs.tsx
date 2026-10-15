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
    <nav className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-neutral-200 bg-white px-3">
      {APP_TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={`relative whitespace-nowrap px-3 py-2.5 text-sm ${
            tab.id === active ? 'font-medium text-neutral-900' : 'text-neutral-500 hover:text-neutral-900'
          }`}
        >
          {tab.label}
          {tab.id === active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-neutral-900" />}
        </button>
      ))}
    </nav>
  )
}
