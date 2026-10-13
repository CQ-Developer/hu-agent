import { useCallback, useEffect, useState } from 'react'

import type { SkillView } from '@shared/ipc'

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
      <p className="text-[11px] leading-relaxed text-neutral-400">
        Skill 目录：全局 <code>~/.hu-agent/skills/&lt;name&gt;/SKILL.md</code>；工作空间{' '}
        <code>&lt;workspace&gt;/.hu/skills/&lt;name&gt;/SKILL.md</code>。同名时工作空间优先。
      </p>

      {skills.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-xs text-neutral-400">
          未发现 Skill。把包含 SKILL.md 的目录放入上述任一位置后点击「刷新」。
        </div>
      )}

      {skills.map((skill) => (
        <div key={`${skill.scope}/${skill.name}`} className="rounded-lg border border-neutral-200 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{skill.name}</span>
                {skill.version && <span className="text-[11px] text-neutral-400">v{skill.version}</span>}
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500">
                  {skill.scope === 'workspace' ? '工作空间' : '全局'}
                </span>
                {skill.market && (
                  <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">市场</span>
                )}
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    skill.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-neutral-100 text-neutral-500'
                  }`}
                >
                  {skill.enabled ? '已启用' : skill.intentEnabled ? '已启用（被服务端暂停）' : '未启用'}
                </span>
                {skill.state && skill.state !== 'active' && (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                    {skill.state === 'delisted'
                      ? '已下架'
                      : skill.state === 'disabled'
                        ? '服务端已停用'
                        : skill.state === 'revoked'
                          ? '版本已撤回'
                          : skill.state === 'not_found'
                            ? '服务端已删除'
                            : '状态未知'}
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs text-neutral-600">{skill.description}</div>
              {skill.whenToUse && <div className="mt-0.5 text-[11px] text-neutral-400">适用：{skill.whenToUse}</div>}
              {skill.stateReason && <div className="mt-0.5 text-[11px] text-amber-700">{skill.stateReason}</div>}
              {skill.replacementVersion && (
                <div className="text-[11px] text-neutral-500">建议升级到 v{skill.replacementVersion}</div>
              )}
              <div className="mt-1 truncate text-[11px] text-neutral-400" title={skill.path}>
                {skill.path}
              </div>
            </div>
            <button
              type="button"
              onClick={() => (skill.intentEnabled ? void toggle(skill, false) : requestEnable(skill))}
              className={`shrink-0 rounded-md px-3 py-1.5 text-xs ${
                skill.intentEnabled
                  ? 'border border-neutral-300 text-neutral-700 hover:bg-neutral-100'
                  : 'bg-neutral-900 text-white hover:bg-neutral-700'
              }`}
            >
              {skill.intentEnabled ? '停用' : '启用'}
            </button>
          </div>

          {confirming?.name === skill.name && confirming.scope === skill.scope && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              <div className="font-medium">该 Skill 声明了额外权限，启用前请确认：</div>
              <ul className="mt-1 list-disc pl-4">
                {confirming.requires?.tools?.map((tool) => <li key={tool}>需要工具权限：{tool}</li>)}
                {confirming.requires?.bins?.map((bin) => <li key={bin}>依赖可执行程序：{bin}</li>)}
                {confirming.requires?.network && <li>需要访问网络</li>}
              </ul>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => void toggle(confirming, true)}
                  className="rounded bg-amber-700 px-2.5 py-1 text-white hover:bg-amber-600"
                >
                  确认启用
                </button>
                <button type="button" onClick={() => setConfirming(null)} className="rounded border border-amber-400 px-2.5 py-1">
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {error && <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}

      <button type="button" onClick={() => void refresh()} className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100">
        刷新
      </button>
    </div>
  )
}
