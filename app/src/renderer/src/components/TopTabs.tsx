export type AppTab =
  | 'chat'
  | 'market'
  | 'models'
  | 'skills'
  | 'mcp'
  | 'workspace'
  | 'sync'
  | 'permissions'
  | 'about'

export const APP_TABS: { id: AppTab; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'market', label: '市场' },
  { id: 'models', label: '模型配置' },
  { id: 'skills', label: 'Skill 配置' },
  { id: 'mcp', label: 'MCP 配置' },
  { id: 'workspace', label: '工作空间' },
  { id: 'sync', label: '云同步' },
  { id: 'permissions', label: '权限与审计' },
  { id: 'about', label: '关于' },
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
