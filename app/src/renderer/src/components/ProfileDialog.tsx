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
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[560px] w-[520px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <span className="text-sm font-semibold">{t('个人中心')}</span>
          <button type="button" onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-900">
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
