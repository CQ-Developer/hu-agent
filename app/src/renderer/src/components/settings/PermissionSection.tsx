import { useCallback, useEffect, useState } from 'react'

import type { AuditEntryView, PolicyRuleView } from '@shared/ipc'
import { t } from '../../i18n'

export default function PermissionSection() {
  const [rules, setRules] = useState<{ workspace: PolicyRuleView[]; global: PolicyRuleView[] }>({
    workspace: [],
    global: [],
  })
  const [audit, setAudit] = useState<AuditEntryView[]>([])

  const refresh = useCallback(async (): Promise<void> => {
    const [nextRules, nextAudit] = await Promise.all([
      window.huAgent.permissions.rules(),
      window.huAgent.permissions.audit(50),
    ])
    setRules(nextRules)
    setAudit(nextAudit)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">
          {t('策略规则（「始终允许」授权会写入工作空间策略）')}
        </h3>
        {rules.workspace.length === 0 && rules.global.length === 0 ? (
          <p className="text-xs text-neutral-400">{t('当前没有持久化规则；默认策略为：工作空间内允许、越界询问、敏感路径拒绝。')}</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-neutral-400">
              <tr>
                <th className="py-1">{t('来源')}</th>
                <th>{t('工具')}</th>
                <th>{t('路径')}</th>
                <th>{t('动作')}</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...rules.workspace.map((rule) => ({ rule, source: t('工作空间') })),
                ...rules.global.map((rule) => ({ rule, source: t('全局') })),
              ].map(({ rule, source }, index) => (
                <tr key={index} className="border-t border-neutral-100">
                  <td className="py-1">{source}</td>
                  <td className="font-mono">{rule.tools.join(', ')}</td>
                  <td className="truncate">{rule.paths?.join(', ') ?? t('（任意）')}</td>
                  <td>{rule.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">{t('最近决策（.hu/logs/audit.jsonl）')}</h3>
        {audit.length === 0 ? (
          <p className="text-xs text-neutral-400">{t('暂无审计记录')}</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left text-neutral-400">
              <tr>
                <th className="py-1">{t('时间')}</th>
                <th>{t('工具')}</th>
                <th>{t('摘要')}</th>
                <th>{t('决策')}</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry, index) => (
                <tr key={index} className="border-t border-neutral-100">
                  <td className="py-1 whitespace-nowrap">{new Date(entry.ts).toLocaleTimeString()}</td>
                  <td className="font-mono">{entry.tool}</td>
                  <td className="max-w-[260px] truncate" title={entry.summary}>
                    {entry.summary}
                  </td>
                  <td
                    className={
                      entry.decision === 'deny' ? 'text-rose-600' : entry.decision === 'allow' ? 'text-emerald-700' : 'text-amber-700'
                    }
                  >
                    {entry.decision}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <button type="button" onClick={() => void refresh()} className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100">
        {t('刷新')}
      </button>
    </div>
  )
}
