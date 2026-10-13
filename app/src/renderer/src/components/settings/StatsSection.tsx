import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  ActivationView,
  StatsOrgOption,
  StatsScope,
  StatsTeamOption,
  UsageGroupBy,
  UsageStatsViewResult,
} from '@shared/ipc'

import { csvBlob, toCsv } from '../../lib/csv'

const GROUP_BY_OPTIONS: Record<StatsScope, { value: UsageGroupBy; label: string }[]> = {
  self: [
    { value: 'day', label: '按日' },
    { value: 'model', label: '按模型' },
  ],
  team: [
    { value: 'day', label: '按日' },
    { value: 'model', label: '按模型' },
    { value: 'member', label: '按成员' },
  ],
  org: [
    { value: 'day', label: '按日' },
    { value: 'model', label: '按模型' },
    { value: 'team', label: '按团队' },
  ],
  global: [
    { value: 'day', label: '按日' },
    { value: 'model', label: '按模型' },
    { value: 'org', label: '按组织' },
  ],
}

function monthStart(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`
  return String(value)
}

export default function StatsSection() {
  const [isSystemAdmin, setIsSystemAdmin] = useState(false)
  const [scope, setScope] = useState<StatsScope>('self')
  const [groupBy, setGroupBy] = useState<UsageGroupBy>('day')
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(today())
  const [teams, setTeams] = useState<StatsTeamOption[]>([])
  const [orgs, setOrgs] = useState<StatsOrgOption[]>([])
  const [teamId, setTeamId] = useState('')
  const [orgId, setOrgId] = useState('')
  const [usage, setUsage] = useState<UsageStatsViewResult | null>(null)
  const [activations, setActivations] = useState<ActivationView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      const cloud = await window.huAgent.cloud.status()
      const admin = Boolean(cloud.user?.isSystemAdmin)
      setIsSystemAdmin(admin)
      if (!admin) return
      try {
        const [teamList, orgList] = await Promise.all([window.huAgent.stats.teams(), window.huAgent.stats.orgs()])
        setTeams(teamList)
        setOrgs(orgList)
      } catch {
        // 无团队/组织时忽略
      }
    })()
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const [usageView, activationList] = await Promise.all([
        window.huAgent.stats.usage({
          scope,
          from,
          to,
          groupBy,
          teamId: scope === 'team' ? teamId : undefined,
          orgId: scope === 'org' ? orgId : undefined,
        }),
        window.huAgent.stats
          .activations({ scope, teamId: scope === 'team' ? teamId : undefined, orgId: scope === 'org' ? orgId : undefined })
          .catch(() => [] as ActivationView[]),
      ])
      setUsage(usageView)
      setActivations(activationList)
    } catch (cause) {
      setUsage(null)
      setActivations([])
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [from, groupBy, orgId, scope, teamId, to])

  useEffect(() => {
    void load()
  }, [load])

  const maxDayTokens = useMemo(() => {
    if (!usage || usage.groupBy !== 'day') return 0
    return Math.max(1, ...usage.rows.map((row) => row.inputTokens + row.outputTokens))
  }, [usage])

  const exportCsv = (): void => {
    if (!usage) return
    const headers = [
      '分组',
      '日期',
      '供应商',
      '模型',
      '输入 tokens',
      '输出 tokens',
      '缓存读',
      '缓存写',
      '请求数',
      '错误数',
      '估算花费',
      '币种',
    ]
    const rows = usage.rows.map((row) => [
      row.key,
      row.day ?? '',
      row.provider ?? '',
      row.model ?? '',
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
      row.requests,
      row.errors,
      row.estimatedCost,
      usage.currency,
    ])
    const url = URL.createObjectURL(csvBlob(toCsv(headers, rows)))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `hu-agent-usage-${usage.scope}-${from}_${to}.csv`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const scopeOptions: { value: StatsScope; label: string }[] = [
    { value: 'self', label: '个人' },
    { value: 'team', label: '团队' },
    { value: 'org', label: '组织' },
    ...(isSystemAdmin ? [{ value: 'global' as StatsScope, label: '全局' }] : []),
  ]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          范围
          <select
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
            value={scope}
            onChange={(event) => {
              const next = event.target.value as StatsScope
              setScope(next)
              setGroupBy(GROUP_BY_OPTIONS[next][0]!.value)
            }}
          >
            {scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        {scope === 'team' && (
          <label className="flex flex-col gap-1">
            团队
            <select
              className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
              value={teamId}
              onChange={(event) => setTeamId(event.target.value)}
            >
              <option value="">（选择团队）</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scope === 'org' && (
          <label className="flex flex-col gap-1">
            组织
            <select
              className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
              value={orgId}
              onChange={(event) => setOrgId(event.target.value)}
            >
              <option value="">（选择组织）</option>
              {orgs.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="flex flex-col gap-1">
          起始
          <input
            type="date"
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          截止
          <input
            type="date"
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          维度
          <select
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
            value={groupBy}
            onChange={(event) => setGroupBy(event.target.value as UsageGroupBy)}
          >
            {GROUP_BY_OPTIONS[scope].map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          disabled={busy || (scope === 'team' && !teamId) || (scope === 'org' && !orgId)}
          onClick={() => void load()}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
        >
          {busy ? '查询中…' : '查询'}
        </button>
        <button
          type="button"
          disabled={!usage || usage.rows.length === 0}
          onClick={exportCsv}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-40"
        >
          导出 CSV
        </button>
      </div>

      {error && <div className="rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}

      {usage && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: '输入 tokens', value: formatTokens(usage.totals.inputTokens) },
              { label: '输出 tokens', value: formatTokens(usage.totals.outputTokens) },
              { label: '请求数', value: String(usage.totals.requests) },
              {
                label: '估算花费',
                value: `${usage.totals.estimatedCost.toFixed(4)} ${usage.currency}`,
              },
            ].map((card) => (
              <div key={card.label} className="rounded-lg border border-neutral-200 p-3">
                <div className="text-[11px] text-neutral-400">{card.label}</div>
                <div className="text-lg">{card.value}</div>
              </div>
            ))}
          </div>

          {usage.groupBy === 'day' && usage.rows.length > 0 && (
            <div className="rounded-lg border border-neutral-200 p-3">
              <div className="mb-2 text-xs font-semibold text-neutral-500">每日 token（输入+输出）</div>
              <div className="flex h-28 items-end gap-1">
                {usage.rows.map((row) => {
                  const total = row.inputTokens + row.outputTokens
                  return (
                    <div key={row.key} className="flex min-w-[10px] flex-1 flex-col items-center gap-1" title={`${row.key}: ${total}`}>
                      <div
                        className="w-full rounded-t bg-neutral-800"
                        style={{ height: `${Math.max(2, (total / maxDayTokens) * 96)}px` }}
                      />
                      <span className="rotate-45 whitespace-nowrap text-[9px] text-neutral-400">{row.day?.slice(5) ?? row.key}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-neutral-200">
            <table className="w-full text-xs">
              <thead className="bg-neutral-50 text-left text-neutral-500">
                <tr>
                  <th className="px-3 py-2">{usage.groupBy === 'day' ? '日期' : '分组'}</th>
                  <th className="px-3 py-2">输入</th>
                  <th className="px-3 py-2">输出</th>
                  <th className="px-3 py-2">缓存读</th>
                  <th className="px-3 py-2">请求</th>
                  <th className="px-3 py-2">错误</th>
                  <th className="px-3 py-2">估算花费</th>
                </tr>
              </thead>
              <tbody>
                {usage.rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-3 text-neutral-400">
                      该区间没有用量记录（客户端产生用量后会自动上报并聚合）
                    </td>
                  </tr>
                )}
                {usage.rows.map((row) => (
                  <tr key={row.key} className="border-t border-neutral-100">
                    <td className="px-3 py-1.5">{row.day ?? row.key}</td>
                    <td className="px-3 py-1.5">{row.inputTokens}</td>
                    <td className="px-3 py-1.5">{row.outputTokens}</td>
                    <td className="px-3 py-1.5">{row.cacheReadTokens}</td>
                    <td className="px-3 py-1.5">{row.requests}</td>
                    <td className={`px-3 py-1.5 ${row.errors > 0 ? 'text-rose-600' : ''}`}>{row.errors}</td>
                    <td className="px-3 py-1.5">
                      {row.estimatedCost.toFixed(4)} {usage.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">资源激活明细</h3>
        {activations.length === 0 ? (
          <p className="text-xs text-neutral-400">暂无激活记录（启用 Skill / MCP 后会自动上报）</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200">
            <table className="w-full text-xs">
              <thead className="bg-neutral-50 text-left text-neutral-500">
                <tr>
                  <th className="px-3 py-2">用户</th>
                  <th className="px-3 py-2">类型</th>
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">版本</th>
                  <th className="px-3 py-2">启用</th>
                  <th className="px-3 py-2">设备数</th>
                  <th className="px-3 py-2">服务端状态</th>
                  <th className="px-3 py-2">最后上报</th>
                </tr>
              </thead>
              <tbody>
                {activations.map((item) => (
                  <tr key={`${item.userId}-${item.resourceType}-${item.refId ?? item.name}-${item.version ?? ''}`} className="border-t border-neutral-100">
                    <td className="px-3 py-1.5">{item.email}</td>
                    <td className="px-3 py-1.5">{item.resourceType}</td>
                    <td className="px-3 py-1.5">{item.name}</td>
                    <td className="px-3 py-1.5">{item.version ?? '-'}</td>
                    <td className="px-3 py-1.5">{item.enabled ? '是' : '否'}</td>
                    <td className="px-3 py-1.5">{item.deviceCount}</td>
                    <td className="px-3 py-1.5">{item.serverState ?? '-'}</td>
                    <td className="px-3 py-1.5">{new Date(item.lastReportedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="text-[11px] leading-relaxed text-neutral-400">
        数据来源：客户端上报的 token 事件按小时聚合到日表，价格表按调用当日生效价估算；上报不含提示词、回复与文件路径。
        团队/组织范围需要对应管理员权限。
      </p>
    </div>
  )
}
