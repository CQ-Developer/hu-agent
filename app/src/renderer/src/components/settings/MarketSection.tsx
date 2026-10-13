import { useCallback, useEffect, useState } from 'react'

import type { InstalledSkillView, MarketDetailView, MarketSkillView } from '@shared/ipc'

const STATE_LABEL: Record<string, string> = {
  active: '正常',
  delisted: '已下架',
  disabled: '已停用',
  revoked: '版本已撤回',
  not_found: '已删除',
  unknown: '状态未知',
}

export default function MarketSection({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<MarketSkillView[]>([])
  const [installed, setInstalled] = useState<InstalledSkillView[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name' | 'downloads'>('updated')
  const [detail, setDetail] = useState<MarketDetailView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [list, mine] = await Promise.all([
      window.huAgent.market.list({ q: query.trim(), sort }),
      window.huAgent.market.installed(),
    ])
    setItems(list)
    setInstalled(mine)
  }, [query, sort])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      await refresh()
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const checkStatus = (): Promise<void> =>
    run(async () => {
      const result = await window.huAgent.market.checkStatus(true)
      setMessage(
        result.error
          ? `状态检查失败：${result.error}`
          : result.skipped
            ? '本地缓存较新，已跳过（15 分钟内）'
            : `已检查 ${result.checked} 个资源`,
      )
    })

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-neutral-400">
        市场资源按团队可见；安装 = 下载 → sha256 校验 → 安全解压到{' '}
        <code>~/.hu-agent/skills/&lt;name&gt;/&lt;version&gt;/</code>（不自动启用）。下架为软状态（可用但不再更新），
        停用/撤回/删除为硬停用，实际生效 = 用户意图 ∧ 服务端状态，恢复后按原意图自动恢复。
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="min-w-[200px] flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm"
          placeholder="搜索名称/描述/标签"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select
          className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
          value={sort}
          onChange={(event) => setSort(event.target.value as typeof sort)}
        >
          <option value="updated">按更新</option>
          <option value="name">按名称</option>
          <option value="downloads">按下载量</option>
        </select>
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-40"
        >
          刷新
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void checkStatus()}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-40"
        >
          状态检查
        </button>
      </div>

      {message && <div className="rounded-md bg-neutral-100 px-3 py-2 text-xs text-neutral-600">{message}</div>}

      {items.length === 0 && (
        <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-xs text-neutral-400">
          暂无可用的市场资源（需要组织管理员审批发布后才会出现在这里）。
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="rounded-lg border border-neutral-200 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{item.name}</span>
                  {item.latestVersion && <span className="text-[11px] text-neutral-400">v{item.latestVersion}</span>}
                  {item.installedVersion && (
                    <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">
                      已安装 v{item.installedVersion}
                    </span>
                  )}
                  {item.updateAvailable && (
                    <span className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">有更新</span>
                  )}
                  {item.state && item.state !== 'active' && (
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">
                      {STATE_LABEL[item.state] ?? item.state}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-neutral-600">{item.description}</div>
                {item.stateReason && <div className="mt-0.5 text-[11px] text-amber-700">{item.stateReason}</div>}
                {item.replacementVersion && (
                  <div className="text-[11px] text-neutral-500">建议升级到 v{item.replacementVersion}</div>
                )}
                <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-neutral-400">
                  {item.tags.map((tag) => (
                    <span key={tag} className="rounded bg-neutral-100 px-1.5 py-0.5">
                      {tag}
                    </span>
                  ))}
                  <span>下载 {item.downloadCount}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                {item.latestVersion && (
                  <button
                    type="button"
                    disabled={busy || item.state === 'disabled' || item.state === 'not_found'}
                    onClick={() =>
                      void run(async () => {
                        const result = await window.huAgent.market.install(item.id, item.latestVersion!)
                        setMessage(`已安装 ${result.name} v${result.version}（${result.files} 个文件），请在 Skill 配置中启用`)
                      })
                    }
                    className="rounded-md bg-neutral-900 px-3 py-1.5 text-white hover:bg-neutral-700 disabled:opacity-40"
                  >
                    {item.installedVersion ? '安装/更新' : '安装'}
                  </button>
                )}
                <button
                  type="button"
                  className="text-blue-600 hover:underline"
                  onClick={() =>
                    void run(async () => {
                      setDetail(await window.huAgent.market.detail(item.id))
                    })
                  }
                >
                  详情
                </button>
                {item.installedVersion && (
                  <button
                    type="button"
                    disabled={busy}
                    className="text-rose-600 hover:underline disabled:opacity-40"
                    onClick={() =>
                      void run(async () => {
                        const removed = await window.huAgent.market.uninstall(item.id)
                        setMessage(`已卸载 ${removed} 个版本`)
                      })
                    }
                  >
                    卸载
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">本机已安装（市场来源）</h3>
        {installed.length === 0 ? (
          <p className="text-xs text-neutral-400">尚未从市场安装任何资源</p>
        ) : (
          <ul className="space-y-1">
            {installed.map((item) => (
              <li
                key={`${item.skillId}-${item.version}`}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {item.name} <span className="text-neutral-400">v{item.version}</span>
                  </div>
                  <div className="truncate text-neutral-400">sha256:{item.digest.replace(/^sha256:/, '').slice(0, 16)}…</div>
                  {item.stateReason && <div className="text-amber-700">{item.stateReason}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      item.state === 'disabled' || item.state === 'revoked' || item.state === 'not_found'
                        ? 'bg-rose-100 text-rose-700'
                        : item.state === 'delisted'
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-emerald-100 text-emerald-700'
                    }`}
                  >
                    {item.state ? (STATE_LABEL[item.state] ?? item.state) : '未同步'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {detail && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setDetail(null)}>
          <div
            className="flex max-h-[640px] w-[720px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
              <span className="text-sm font-semibold">
                {detail.name} {detail.latestVersion ? `v${detail.latestVersion}` : ''}
              </span>
              <button type="button" onClick={() => setDetail(null)} className="text-xs text-neutral-500 hover:text-neutral-900">
                关闭
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-xs">
              <div>
                <div className="font-medium text-neutral-700">权限声明</div>
                <div className="mt-1 text-neutral-500">
                  工具：{detail.requires.tools.join(', ') || '无'}；依赖程序：{detail.requires.bins.join(', ') || '无'}；
                  网络：{detail.requires.network ? '需要' : '不需要'}
                </div>
                {detail.scripts.length > 0 && (
                  <div className="mt-1 text-amber-700">包含脚本：{detail.scripts.join(', ')}</div>
                )}
              </div>
              <div>
                <div className="font-medium text-neutral-700">版本</div>
                <table className="mt-1 w-full">
                  <thead className="text-left text-neutral-400">
                    <tr>
                      <th className="py-1">版本</th>
                      <th>状态</th>
                      <th>大小</th>
                      <th>变更说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.versions.map((version) => (
                      <tr key={version.version} className="border-t border-neutral-100">
                        <td className="py-1 font-mono">{version.version}</td>
                        <td>{version.status}</td>
                        <td>{(version.sizeBytes / 1024).toFixed(1)} KB</td>
                        <td className="truncate">{version.changelog || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="font-medium text-neutral-700">SKILL.md 预览</div>
                <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-neutral-50 p-3 text-[11px] text-neutral-700">
                  {detail.skillMd || '（无）'}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
