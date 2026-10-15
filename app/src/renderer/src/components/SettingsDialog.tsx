/**
 * 设置面（导航重构 2026-10-15）：原来的 8 个顶部 tab 收进这里。
 *
 * 分组：工作区（模型/Skill/MCP/工作空间）、团队与云（云同步/用量统计）、系统（权限与审计/关于）。
 * 「市场」保留在顶部导航，「个人中心」仍在侧栏底部。
 */

import { useEffect, useState } from 'react'

import type { WorkspaceInfoView } from '@shared/ipc'
import { t } from '../i18n'
import AboutSection from './settings/AboutSection'
import McpSection from './settings/McpSection'
import ModelSection from './settings/ModelSection'
import PermissionSection from './settings/PermissionSection'
import SkillsSection from './settings/SkillsSection'
import StatsSection from './settings/StatsSection'
import SyncSection from './settings/SyncSection'
import WorkspaceSection from './settings/WorkspaceSection'

type SectionId = 'models' | 'skills' | 'mcp' | 'workspace' | 'sync' | 'stats' | 'permissions' | 'about'

interface SectionDef {
  id: SectionId
  label: string
}

interface GroupDef {
  title: string
  items: SectionDef[]
}

interface Props {
  onClose: () => void
  onChanged: () => void
  workspaces: WorkspaceInfoView[]
  activeWorkspace: WorkspaceInfoView | null
  onSwitchWorkspace: (id: string) => void
  onPickWorkspace: () => void
}

export default function SettingsDialog({
  onClose,
  onChanged,
  workspaces,
  activeWorkspace,
  onSwitchWorkspace,
  onPickWorkspace,
}: Props) {
  const [section, setSection] = useState<SectionId>('models')

  // 在组件内用 t() 字面量构建：既随语言切换刷新，也被 i18n 扫描器识别（无死键）
  const groups: GroupDef[] = [
    {
      title: t('工作区'),
      items: [
        { id: 'models', label: t('模型配置') },
        { id: 'skills', label: t('Skill 配置') },
        { id: 'mcp', label: t('MCP 配置') },
        { id: 'workspace', label: t('工作空间') },
      ],
    },
    {
      title: t('团队与云'),
      items: [
        { id: 'sync', label: t('云同步') },
        { id: 'stats', label: t('用量统计') },
      ],
    },
    {
      title: t('系统'),
      items: [
        { id: 'permissions', label: t('权限与审计') },
        { id: 'about', label: t('关于') },
      ],
    },
  ]

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/45 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass flex h-[min(680px,88vh)] w-[min(920px,94vw)] flex-col overflow-hidden rounded-panel"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-title font-semibold">{t('设置')}</span>
          <button type="button" onClick={onClose} className="ui-btn ui-btn-ghost px-3.5 py-1.5 text-caption">
            {t('关闭')}
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <nav className="w-52 shrink-0 overflow-y-auto border-r border-line p-3">
            {groups.map((group) => (
              <div key={group.title} className="mb-3">
                <div className="mb-1 px-2 text-caption font-medium text-fg-subtle">{group.title}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSection(item.id)}
                    className={`mb-0.5 w-full rounded-field px-3 py-2 text-left text-small transition duration-200 ease-standard ${
                      item.id === section
                        ? 'bg-accent-soft text-accent shadow-[inset_0_0_0_1px_var(--ui-accent-ring)]'
                        : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            {section === 'models' && <ModelSection onChanged={onChanged} />}
            {section === 'skills' && <SkillsSection onChanged={onChanged} />}
            {section === 'mcp' && <McpSection onChanged={onChanged} />}
            {section === 'workspace' && (
              <WorkspaceSection
                workspaces={workspaces}
                activeWorkspace={activeWorkspace}
                onSwitch={onSwitchWorkspace}
                onPick={onPickWorkspace}
              />
            )}
            {section === 'sync' && <SyncSection onChanged={onChanged} />}
            {section === 'stats' && <StatsSection />}
            {section === 'permissions' && <PermissionSection />}
            {section === 'about' && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  )
}
