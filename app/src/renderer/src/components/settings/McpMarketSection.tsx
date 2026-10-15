import { useCallback, useEffect, useState } from 'react'

import type { MarketMcpDetailView, MarketMcpServerView } from '@shared/ipc'
import { t } from '../../i18n'
import GlassSelect from '../ui/GlassSelect'
import { MARKET_STATE_LABEL } from './market_labels'

/** MCP 市场（design 5.8.3 / 6.5）：浏览 → 详情（config_template/env_schema）→ 安装引导填密钥。 */
export default function McpMarketSection({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<MarketMcpServerView[]>([])
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'updated' | 'name'>('updated')
  const [detail, setDetail] = useState<MarketMcpDetailView | null>(null)
  const [install, setInstall] = useState<MarketMcpDetailView | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setItems(await window.huAgent.market.mcpList({ q: query.trim(), sort }))
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

  const openInstall = (item: MarketMcpServerView): Promise<void> =>
    run(async () => {
      setValues({})
      setInstall(await window.huAgent.market.mcpDetail(item.id))
    })

  const submitInstall = (): Promise<void> =>
    run(async () => {
      if (!install || install.latestVersion === null) return
      await window.huAgent.market.mcpInstall(install.id, install.latestVersion, values)
      setMessage(t('已安装 MCP {name}（可在 MCP 配置中启停）', { name: install.name }))
      setInstall(null)
    })

  const detailTransport = (item: MarketMcpDetailView): string =>
    item.versions.find((version) => version.version === item.latestVersion)?.transport ?? '-'

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {t('MCP 资源是连接描述（配置模板 + 环境变量声明）；安装会写入本机 mcp.json，密钥值只保存在本机密钥库（服务端不接触）。下架为软状态，停用/撤回/删除为硬停用。')}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="min-w-[200px] flex-1 rounded border border-line-strong px-2 py-1.5 text-sm"
          placeholder={t('搜索名称/描述/标签')}
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
      </div>

      {message && <div className="rounded-md bg-surface-2 px-3 py-2 text-xs text-fg-muted">{message}</div>}

      {items.length === 0 && (
        <div className="rounded-lg border border-dashed border-line-strong p-4 text-xs text-fg-subtle">
          {t('暂无 MCP 资源（需要团队管理员审批发布后才会出现在这里）。')}
        </div>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <div key={item.id} className="rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{item.name}</span>
                  {item.latestVersion !== null && (
                    <span className="text-[11px] text-fg-subtle">v{item.latestVersion}</span>
                  )}
                  {item.installedVersion !== null && (
                    <span className="rounded bg-success-soft px-1.5 py-0.5 text-[10px] text-success">
                      {t('已安装 v')}
                      {item.installedVersion}
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
                  <div className="text-[11px] text-fg-muted">
                    {t('建议升级到 v')}
                    {item.replacementVersion}
                  </div>
                )}
                <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-fg-subtle">
                  {item.tags.map((tag) => (
                    <span key={tag} className="rounded bg-surface-2 px-1.5 py-0.5">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
                {item.latestVersion !== null && (
                  <button
                    type="button"
                    disabled={busy || item.state === 'disabled' || item.state === 'not_found'}
                    onClick={() => void openInstall(item)}
                    className="rounded-md bg-accent px-3 py-1.5 text-white hover:bg-accent-hover disabled:opacity-40"
                  >
                    {item.installedVersion !== null ? t('安装/更新') : t('安装')}
                  </button>
                )}
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() =>
                    void run(async () => {
                      setDetail(await window.huAgent.market.mcpDetail(item.id))
                    })
                  }
                >
                  {t('详情')}
                </button>
                {item.installedVersion !== null && (
                  <button
                    type="button"
                    disabled={busy}
                    className="text-danger hover:underline disabled:opacity-40"
                    onClick={() =>
                      void run(async () => {
                        await window.huAgent.market.mcpUninstall(item.id)
                        setMessage(t('已卸载 MCP {name}', { name: item.name }))
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

      {detail && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setDetail(null)}>
          <div
            className="flex max-h-[640px] w-[720px] flex-col overflow-hidden rounded-xl bg-surface-2 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="text-sm font-semibold">
                {detail.name} {detail.latestVersion !== null ? `v${detail.latestVersion}` : ''}
              </span>
              <button type="button" onClick={() => setDetail(null)} className="text-xs text-fg-muted hover:text-fg">
                {t('关闭')}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-xs">
              <div>
                <div className="font-medium text-fg">{t('传输方式')}</div>
                <div className="mt-1 text-fg-muted">{detailTransport(detail)}</div>
              </div>
              <div>
                <div className="font-medium text-fg">{t('配置模板')}</div>
                <pre className="mt-1 overflow-auto rounded-md bg-surface p-3 text-[11px] text-fg">
                  {JSON.stringify(detail.configTemplate ?? {}, null, 2)}
                </pre>
              </div>
              <div>
                <div className="font-medium text-fg">{t('环境变量声明')}</div>
                <div className="mt-1 space-y-1 text-fg-muted">
                  {detail.envSchema.length === 0 && <span>{t('（无）')}</span>}
                  {detail.envSchema.map((field) => (
                    <div key={field.key}>
                      <span className="font-mono">{field.key}</span> · {field.label}
                      {field.secret ? ` · ${t('密钥')}` : ''}
                      {field.required ? ` · ${t('必填')}` : ''}
                      {field.help ? ` · ${field.help}` : ''}
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="font-medium text-fg">{t('版本')}</div>
                <table className="mt-1 w-full">
                  <thead className="text-left text-fg-subtle">
                    <tr>
                      <th className="py-1">{t('版本')}</th>
                      <th>{t('状态')}</th>
                      <th>{t('传输方式')}</th>
                      <th>{t('变更说明')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.versions.map((version) => (
                      <tr key={version.id} className="border-t border-line">
                        <td className="py-1 font-mono">v{version.version}</td>
                        <td>{version.status}</td>
                        <td>{version.transport}</td>
                        <td className="truncate">{version.changelog || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <div className="font-medium text-fg">{t('文档')}</div>
                <pre className="mt-1 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-md bg-surface p-3 text-[11px] text-fg">
                  {detail.docsMd || t('（无）')}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {install && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setInstall(null)}>
          <div
            className="flex max-h-[640px] w-[560px] flex-col overflow-hidden rounded-xl bg-surface-2 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <span className="text-sm font-semibold">{t('安装 MCP：{name}', { name: install.name })}</span>
              <button
                type="button"
                onClick={() => setInstall(null)}
                className="text-xs text-fg-muted hover:text-fg"
              >
                {t('关闭')}
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4 text-xs">
              <div className="text-fg-muted">
                {t('传输方式')}：{detailTransport(install)}
              </div>
              {install.envSchema.length === 0 ? (
                <div className="text-fg-muted">{t('该 MCP 不需要额外配置，点击安装即可。')}</div>
              ) : (
                install.envSchema.map((field) => (
                  <label key={field.key} className="block space-y-1">
                    <span className="font-medium text-fg">
                      {field.label} <span className="font-mono text-fg-subtle">{field.key}</span>
                      {field.required && <span className="text-danger"> *</span>}
                    </span>
                    <input
                      type={field.secret ? 'password' : 'text'}
                      className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
                      value={values[field.key] ?? ''}
                      onChange={(event) => setValues((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    />
                    {field.secret && (
                      <span className="block text-[10px] text-fg-subtle">
                        {t('该字段为密钥：值只写入本机密钥库，服务端不接触')}
                      </span>
                    )}
                    {field.help && <span className="block text-[10px] text-fg-subtle">{field.help}</span>}
                  </label>
                ))
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
              <button
                type="button"
                className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2"
                onClick={() => setInstall(null)}
              >
                {t('取消')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void submitInstall()}
                className="rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
              >
                {t('安装')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
