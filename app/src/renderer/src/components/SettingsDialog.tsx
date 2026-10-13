import { useState } from 'react'

import type { UsageStatsView, WorkspaceInfoView } from '@shared/ipc'

import McpSection from './settings/McpSection'
import ModelSection from './settings/ModelSection'
import PermissionSection from './settings/PermissionSection'
import ProfileSection from './settings/ProfileSection'
import SkillsSection from './settings/SkillsSection'
import WorkspaceSection from './settings/WorkspaceSection'

export type SettingsSection = 'profile' | 'models' | 'skills' | 'mcp' | 'workspace' | 'permissions' | 'about'

const SECTIONS: { id: SettingsSection; label: string; icon: string }[] = [
  { id: 'profile', label: '个人中心', icon: '👤' },
  { id: 'models', label: '模型配置', icon: '🧠' },
  { id: 'skills', label: 'Skill 配置', icon: '🧩' },
  { id: 'mcp', label: 'MCP 配置', icon: '🔌' },
  { id: 'workspace', label: '工作空间', icon: '📁' },
  { id: 'permissions', label: '权限与审计', icon: '🛡️' },
  { id: 'about', label: '关于', icon: 'ℹ️' },
]

interface Props {
  initialSection: SettingsSection
  onClose: () => void
  onChanged: () => void
  workspaces: WorkspaceInfoView[]
  activeWorkspace: WorkspaceInfoView | null
  usage: UsageStatsView | null
  onSwitchWorkspace: (id: string) => void
  onPickWorkspace: () => void
}

export default function SettingsDialog({
  initialSection,
  onClose,
  onChanged,
  workspaces,
  activeWorkspace,
  usage,
  onSwitchWorkspace,
  onPickWorkspace,
}: Props) {
  const [section, setSection] = useState<SettingsSection>(initialSection)
  const current = SECTIONS.find((item) => item.id === section)

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex h-[620px] w-[900px] overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <nav className="w-44 shrink-0 space-y-1 border-r border-neutral-200 bg-neutral-50 p-2">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                item.id === section ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-200/60'
              }`}
            >
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
            <span className="text-sm font-semibold">{current?.label ?? '设置'}</span>
            <button type="button" onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-900">
              关闭
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {section === 'profile' && (
              <ProfileSection usage={usage} workspaces={workspaces} activeWorkspace={activeWorkspace} />
            )}
            {section === 'models' && <ModelSection onChanged={onChanged} />}
            {section === 'skills' && <SkillsSection onChanged={onChanged} />}
            {section === 'mcp' && <McpSection />}
            {section === 'workspace' && (
              <WorkspaceSection
                workspaces={workspaces}
                activeWorkspace={activeWorkspace}
                onSwitch={onSwitchWorkspace}
                onPick={onPickWorkspace}
              />
            )}
            {section === 'permissions' && <PermissionSection />}
            {section === 'about' && (
              <div className="space-y-2 text-xs text-neutral-600">
                <p>hu-agent 桌面客户端 · Electron + React + TypeScript</p>
                <p className="text-neutral-400">
                  设计基线 docs/design.md · 执行计划 docs/plan.md · 变更记录 docs/adr/
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
