import { useCallback, useEffect, useState } from 'react'

import type { SkillView } from '@shared/ipc'
import { t } from '../../i18n'

export default function SkillsSection({ onChanged }: { onChanged: () => void }) {
  const [skills, setSkills] = useState<SkillView[]>([])
  const [confirming, setConfirming] = useState<SkillView | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setSkills(await window.huAgent.skills.list())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = async (skill: SkillView, enabled: boolean): Promise<void> => {
    setError(null)
    try {
      const next = await window.huAgent.skills.setEnabled(skill.name, skill.scope, enabled)
      setSkills(next)
      setConfirming(null)
      onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const requestEnable = (skill: SkillView): void => {
    const requires = skill.requires
    const risky = Boolean(requires && ((requires.tools?.length ?? 0) > 0 || requires.network))
    if (risky) setConfirming(skill)
    else void toggle(skill, true)
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {t('Skill 目录：全局')} <code>~/.hu-agent/skills/&lt;name&gt;/SKILL.md</code>{t('；工作空间')}{' '}
        <code>&lt;workspace&gt;/.hu/skills/&lt;name&gt;/SKILL.md</code>{t('。同名时工作空间优先。')}
      </p>

      {skills.length === 0 && (
        <div className="rounded-lg border border-dashed border-line-strong p-4 text-xs text-fg-subtle">
          {t('未发现 Skill。把包含 SKILL.md 的目录放入上述任一位置后点击「刷新」。')}
        </div>
      )}

      {skills.map((skill) => (
        <div key={`${skill.scope}/${skill.name}`} className="rounded-lg border border-line p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{skill.name}</span>
                {skill.version && <span className="text-[11px] text-fg-subtle">v{skill.version}</span>}
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
                  {skill.scope === 'workspace' ? t('工作空间') : t('全局')}
                </span>
                {skill.market && (
                  <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{t('市场')}</span>
                )}
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    skill.enabled ? 'bg-success-soft text-success' : 'bg-surface-2 text-fg-muted'
                  }`}
                >
                  {skill.enabled ? t('已启用') : skill.intentEnabled ? t('已启用（被服务端暂停）') : t('未启用')}
                </span>
                {skill.state && skill.state !== 'active' && (
                  <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] text-warning">
                    {skill.state === 'delisted'
                      ? t('已下架')
                      : skill.state === 'disabled'
                        ? t('服务端已停用')
                        : skill.state === 'revoked'
                          ? t('版本已撤回')
                          : skill.state === 'not_found'
                            ? t('服务端已删除')
                            : t('状态未知')}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-fg-muted">{skill.description}</div>
              {skill.whenToUse && <div className="mt-0.5 text-[11px] text-fg-subtle">{t('适用：')}{skill.whenToUse}</div>}
              {skill.stateReason && <div className="mt-0.5 text-[11px] text-warning">{skill.stateReason}</div>}
              {skill.replacementVersion && (
                <div className="text-[11px] text-fg-muted">{t('建议升级到 v')}{skill.replacementVersion}</div>
              )}
              <div className="mt-1 truncate text-[11px] text-fg-subtle" title={skill.path}>
                {skill.path}
              </div>
            </div>
            <button
              type="button"
              onClick={() => (skill.intentEnabled ? void toggle(skill, false) : requestEnable(skill))}
              className={`shrink-0 rounded-md px-3 py-1.5 text-xs ${
                skill.intentEnabled
                  ? 'border border-line-strong text-fg hover:bg-surface-2'
                  : 'bg-accent text-white hover:bg-accent-hover'
              }`}
            >
              {skill.intentEnabled ? t('停用') : t('启用')}
            </button>
          </div>

          {confirming?.name === skill.name && confirming.scope === skill.scope && (
            <div className="mt-2 rounded-md border border-warning bg-warning-soft p-2 text-xs text-warning">
              <div className="font-medium">{t('该 Skill 声明了额外权限，启用前请确认：')}</div>
              <ul className="mt-1 list-disc pl-4">
                {confirming.requires?.tools?.map((tool) => <li key={tool}>{t('需要工具权限：')}{tool}</li>)}
                {confirming.requires?.bins?.map((bin) => <li key={bin}>{t('依赖可执行程序：')}{bin}</li>)}
                {confirming.requires?.network && <li>{t('需要访问网络')}</li>}
              </ul>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void toggle(confirming, true)}
                  className="rounded bg-warning px-2.5 py-1 text-white hover:bg-warning"
                >
                  {t('确认启用')}
                </button>
                <button type="button" onClick={() => setConfirming(null)} className="rounded border border-warning px-2.5 py-1">
                  {t('取消')}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

      <button type="button" onClick={() => void refresh()} className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2">
        {t('刷新')}
      </button>
    </div>
  )
}
