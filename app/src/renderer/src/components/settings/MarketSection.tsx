import { useCallback, useEffect, useState } from 'react'

import type { InstalledSkillView, MarketDetailView, MarketSkillView } from '@shared/ipc'
import { t } from '../../i18n'
import GlassSelect from '../ui/GlassSelect'
import McpMarketSection from './McpMarketSection'
import { MARKET_STATE_LABEL } from './market_labels'

export default function MarketSection({ onChanged }: { onChanged: () => void }) {
  const [tab, setTab] = useState<'skill' | 'mcp'>('skill')
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
          ? t('状态检查失败：{error}', { error: result.error })
          : result.skipped
            ? t('本地缓存较新，已跳过（15 分钟内）')
            : t('已检查 {checked} 个资源', { checked: result.checked }),
      )
    })

  return (
    <div className="space-y-4">
      <div className="flex gap-1 border-b border-line text-xs">
        <button
          type="button"
          onClick={() => setTab('skill')}
          className={`-mb-px border-b-2 px-3 py-1.5 ${tab === 'skill' ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}
        >
          {t('Skill 市场')}
        </button>
        <button
          type="button"
          onClick={() => setTab('mcp')}
          className={`-mb-px border-b-2 px-3 py-1.5 ${tab === 'mcp' ? 'border-accent font-medium text-fg' : 'border-transparent text-fg-subtle hover:text-fg'}`}
        >
          {t('MCP 市场')}
        </button>
      </div>
      {tab === 'mcp' ? <McpMarketSection onChanged={onChanged} /> : null}
      {tab === 'mcp' ? null : (
      <>
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {t('市场资源按团队可见；安装 = 下载 → sha256 校验 → 安全解压到')}{' '}
        <code>~/.hu-agent/skills/&lt;name&gt;/&lt;version&gt;/</code>{t('（不自动启用）。下架为软状态（可用但不再更新）， 停用/撤回/删除为硬停用，实际生效 = 用户意图 ∧ 服务端状态，恢复后按原意图自动恢复。')}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="min-w-[200px] flex-1 rounded border border-line-strong px-2 py-1.5 text-sm"
          placeholder={t("搜索名称/描述/标签")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <GlassSelect
          small
          className="w-32"
          value={sort}
          onChange={(value) => setSort(value as typeof sort)}
          options={[
            { value: 'updated', label: t('按更新') },
            { value: 'name', label: t('按名称') },
            { value: 'downloads', label: t('按下载量') },
          ]}
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-40"
        >
          {t('刷新')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void checkStatus()}
          className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-40"
        >
          {t('状态检查')}
        </button>
      </div>

      {message && <div className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-muted">{message}</div>}

      {items.length === 0 && (
        <div className="rounded-lg border border-dashed border-line-strong p-4 text-xs text-fg-subtle">
          {t('暂无可用的市场资源（需要组织管理员审批发布后才会出现在这里）。')}
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{item.name}</span>
                  {item.latestVersion && <span className="text-[11px] text-fg-subtle">v{item.latestVersion}</span>}
                  {item.installedVersion && (
                    <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] text-success">
                      {t('已安装 v')}{item.installedVersion}
                    </span>
                  )}
                  {item.updateAvailable && (
                    <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{t('有更新')}</span>
                  )}
                  {item.state && item.state !== 'active' && (
                    <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] text-warning">
                      {MARKET_STATE_LABEL[item.state] ?? item.state}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-xs text-fg-muted">{item.description}</div>
                {item.stateReason && <div className="mt-0.5 text-[11px] text-warning">{item.stateReason}</div>}
                {item.replacementVersion && (
                  <div className="text-[11px] text-fg-muted">{t('建议升级到 v')}{item.replacementVersion}</div>
                )}
                <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-fg-subtle">
                  {item.tags.map((tag) => (
                    <span key={tag} className="rounded bg-surface-2 px-1.5 py-0.5">
                      {tag}
                    </span>
                  ))}
                  <span>{t('下载')} {item.downloadCount}</span>
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
                        setMessage(t('已安装 {name} v{version}（{files} 个文件），请在 Skill 配置中启用', { name: result.name, version: result.version, files: result.files }))
                      })
                    }
                    className="rounded-md bg-accent px-3 py-1.5 text-white hover:bg-accent-hover disabled:opacity-40"
                  >
                    {item.installedVersion ? t('安装/更新') : t('安装')}
                  </button>
                )}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() =>
                    void run(async () => {
                      setDetail(await window.huAgent.market.detail(item.id))
                    })
                  }
                >
                  {t('详情')}
                </button>
                {item.installedVersion && (
                  <button
                    type="button"
                    disabled={busy}
                    className="text-danger hover:underline disabled:opacity-40"
                    onClick={() =>
                      void run(async () => {
                        const removed = await window.huAgent.market.uninstall(item.id)
                        setMessage(t('已卸载 {removed} 个版本', { removed }))
                      })
                    }
                  >
                    {t('卸载')}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-fg-muted">{t('本机已安装（市场来源）')}</h3>
        {installed.length === 0 ? (
          <p className="text-xs text-fg-subtle">{t('尚未从市场安装任何资源')}</p>
        ) : (
          <ul className="space-y-1">
            {installed.map((item) => (
              <li
                key={`${item.skillId}-${item.version}`}
                className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {item.name} <span className="text-fg-subtle">v{item.version}</span>
                  </div>
                  <div className="truncate text-fg-subtle">sha256:{item.digest.replace(/^sha256:/, '').slice(0, 16)}…</div>
                  {item.stateReason && <div className="text-warning">{item.stateReason}</div>}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      item.state === 'disabled' || item.state === 'revoked' || item.state === 'not_found'
                        ? 'bg-danger-soft text-danger'
                        : item.state === 'delisted'
                          ? 'bg-warning-soft text-warning'
                          : 'bg-success-soft text-success'
                    }`}
                  >
                    {item.state ? (MARKET_STATE_LABEL[item.state] ?? item.state) : t('未同步')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      </>
      )}

      {detail && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setDetail(null)}>
          <div
            className="flex max-h-[640px] w-[720px] flex-col overflow-hidden rounded-xl bg-surface-2 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="text-sm font-semibold">
                {detail.name} {detail.latestVersion ? `v${detail.latestVersion}` : ''}
              </span>
              <button type="button" onClick={() => setDetail(null)} className="text-xs text-fg-muted hover:text-fg">
                {t('关闭')}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-xs">
              <div>
                <div className="font-medium text-fg">{t('权限声明')}</div>
                <div className="mt-1 text-fg-muted">
                  {t('工具：')}{detail.requires.tools.join(', ') || t('无')}{t('；依赖程序：')}{detail.requires.bins.join(', ') || t('无')}{t('； 网络：')}{detail.requires.network ? t('需要') : t('不需要')}
                </div>
                {detail.scripts.length > 0 && (
                  <div className="mt-1 text-warning">{t('包含脚本：')}{detail.scripts.join(', ')}</div>
                )}
              </div>
              <div>
                <div className="font-medium text-fg">{t('版本')}</div>
                <table className="mt-1 w-full">
                  <thead className="text-left text-fg-subtle">
                    <tr>
                      <th className="py-1">{t('版本')}</th>
                      <th>{t('状态')}</th>
                      <th>{t('大小')}</th>
                      <th>{t('变更说明')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.versions.map((version) => (
                      <tr key={version.version} className="border-t border-line">
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
                <div className="font-medium text-fg">{t('SKILL.md 预览')}</div>
                <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-surface p-3 text-[11px] text-fg">
                  {detail.skillMd || t('（无）')}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
