import type { UsageStatsView, WorkspaceInfoView } from '@shared/ipc'

import ProfileSection from './settings/ProfileSection'
import { t } from '../i18n'

interface Props {
  usage: UsageStatsView | null
  workspaces: WorkspaceInfoView[]
  activeWorkspace: WorkspaceInfoView | null
  onClose: () => void
  onChanged?: () => void
}

export default function ProfileDialog({ usage, workspaces, activeWorkspace, onClose, onChanged }: Props) {
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="glass flex max-h-[560px] w-[520px] flex-col overflow-hidden rounded-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-sm font-semibold">{t('个人中心')}</span>
          <button type="button" onClick={onClose} className="text-xs text-fg-muted hover:text-fg">
            {t('关闭')}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ProfileSection
            usage={usage}
            workspaces={workspaces}
            activeWorkspace={activeWorkspace}
            onChanged={onChanged}
          />
        </div>
      </div>
    </div>
  )
}
