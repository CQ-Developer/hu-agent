import type { WorkspaceInfoView } from '@shared/ipc'
import { t } from '../../i18n'

interface Props {
  workspaces: WorkspaceInfoView[]
  activeWorkspace: WorkspaceInfoView | null
  onSwitch: (id: string) => void
  onPick: () => void
}

export default function WorkspaceSection({ workspaces, activeWorkspace, onSwitch, onPick }: Props) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {t('工作空间是 Agent 的文件沙箱：读写默认限定在目录内，越界操作会请求授权。每个工作空间拥有独立的会话与 Skill 配置 （')}<code>&lt;workspace&gt;/.hu/</code>{t('）。')}
      </p>

      <ul className="space-y-2">
        {workspaces.map((workspace) => (
          <li
            key={workspace.id}
            className={`flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
              workspace.id === activeWorkspace?.id ? 'border-accent bg-surface' : 'border-line'
            }`}
          >
            <div className="min-w-0">
              <div className="font-medium">
                {workspace.name}
                {workspace.id === activeWorkspace?.id && (
                  <span className="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-[10px] text-success">{t('当前')}</span>
                )}
              </div>
              <div className="truncate text-fg-subtle" title={workspace.root}>
                {workspace.root}
              </div>
            </div>
            {workspace.id !== activeWorkspace?.id && (
              <button type="button" onClick={() => onSwitch(workspace.id)} className="shrink-0 text-accent hover:underline">
                {t('切换')}
              </button>
            )}
          </li>
        ))}
      </ul>

      <button type="button" onClick={onPick} className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2">
        {t('打开其他目录…')}
      </button>
    </div>
  )
}
