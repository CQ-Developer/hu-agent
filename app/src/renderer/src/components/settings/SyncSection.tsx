import { useCallback, useEffect, useState } from 'react'

import type { SyncSettingsView, SyncStatusView, SyncVersionView } from '@shared/ipc'
import { t } from '../../i18n'
import GlassSelect from '../ui/GlassSelect'

const STATUS_LABEL: Record<string, string> = {
  unlinked: t('未关联服务端工作空间'),
  'up-to-date': t('已是最新'),
  'local-changes': t('有本地改动待上传'),
  'remote-changes': t('服务端有新版本'),
  conflict: t('存在冲突，需人工处理'),
  error: t('同步异常'),
}

const SCHEDULE_OPTIONS: { value: SyncSettingsView['schedule']; label: string }[] = [
  { value: 'off', label: t('关闭') },
  { value: '15m', label: t('每 15 分钟') },
  { value: '30m', label: t('每 30 分钟') },
  { value: '1h', label: t('每 1 小时') },
  { value: '6h', label: t('每 6 小时') },
  { value: '24h', label: t('每 24 小时') },
]

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

export default function SyncSection({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<SyncStatusView | null>(null)
  const [versions, setVersions] = useState<SyncVersionView[]>([])
  const [settings, setSettings] = useState<SyncSettingsView | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.huAgent.sync.status()
    setStatus(next)
    setVersions(await window.huAgent.sync.versions())
    setSettings(await window.huAgent.sync.settings())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 定时同步结果推送：自动同步完成后实时更新状态（design 5.11.5）
  useEffect(
    () =>
      window.huAgent.sync.onEvent((view) => {
        setStatus(view)
        void window.huAgent.sync.versions().then(setVersions)
      }),
    [],
  )

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

  const quota = status?.quota
  const quotaPercent = quota && quota.limitBytes > 0 ? Math.min(100, (quota.usedBytes / quota.limitBytes) * 100) : 0

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {t('快照为整体 zip（不做文件级合并）：上传走预签名直传对象存储，服务端校验 sha256； 排除')} <code>.hu/sync</code>{t('、')}<code>.hu/logs</code>{t('、')}<code>.hu/backups</code>{t('、')}<code>node_modules</code>{t('、')}
        <code>.git</code>{t('、')}<code>dist</code>{t('、')}<code>.venv</code>{t('（可在')} <code>.hu/workspace.json</code> {t('的')}{' '}
        <code>syncExclude</code> {t('追加）。只有工作空间所有者可以读写快照。')}
      </p>

      <section className="rounded-lg border border-line p-4">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="rounded bg-surface-2 px-2 py-1">{status ? STATUS_LABEL[status.status] : t('读取中…')}</span>
          {status?.lastVersion !== undefined && <span>{t('版本 v')}{status.lastVersion}</span>}
          {status?.lastSyncedAt && <span className="text-fg-subtle">{t('上次同步')} {new Date(status.lastSyncedAt).toLocaleString()}</span>}
          <span className="text-fg-subtle">
            {t('本地')} {status?.localFiles ?? 0} {t('个文件 /')} {formatBytes(status?.localBytes ?? 0)}
          </span>
          {status?.remoteVersion !== undefined && <span className="text-fg-subtle">{t('服务端 v')}{status.remoteVersion}</span>}
        </div>

        {status?.lastError && (
          <div className="mt-2 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">
            {status.lastError}
            {(settings?.consecutiveFailures ?? 0) >= 3 && (
              <span className="ml-1 font-medium">{t('（已连续失败')} {settings?.consecutiveFailures} {t('次，请检查网络或服务端）')}</span>
            )}
          </div>
        )}

        {quota && (
          <div className="mt-3">
            <div className="flex justify-between text-[11px] text-fg-muted">
              <span>{t('存储用量')}</span>
              <span>
                {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-surface-3">
              <div className="h-1.5 rounded-full bg-accent" style={{ width: `${quotaPercent}%` }} />
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await window.huAgent.sync.now()
                setMessage(t('同步完成：{status}', { status: STATUS_LABEL[result.status] ?? result.status }))
              })
            }
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? t('同步中…') : t('立即同步')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => setStatus(await window.huAgent.sync.status()))}
            className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-40"
          >
            {t('刷新状态')}
          </button>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            {t('定时同步')}
            <GlassSelect
              small
              className="w-28"
              value={settings?.schedule ?? 'off'}
              onChange={(value) =>
                void run(async () => {
                  setSettings(
                    await window.huAgent.sync.setSettings({
                      schedule: value as SyncSettingsView['schedule'],
                      includeSessions: settings?.includeSessions !== false,
                    }),
                  )
                })
              }
              options={SCHEDULE_OPTIONS}
            />
          </label>
        </div>
        {message && <p className="mt-2 text-xs text-fg-muted">{message}</p>}
      </section>

      {status?.conflict && (
        <section className="rounded-lg border border-warning bg-warning-soft p-4">
          <div className="text-sm font-medium text-warning">{t('本地与服务端都有改动，已暂停自动处理')}</div>
          <div className="mt-1 text-xs text-warning">
            {t('服务端 v')}{status.conflict.remoteVersion}{t('；本地')} {status.conflict.localFiles} {t('个文件。 新增')} {status.conflict.diff.added.length}{t('、修改')} {status.conflict.diff.modified.length}{t('、删除')}{' '}
            {status.conflict.diff.removed.length} {t('个文件。')}
          </div>
          {status.conflict.diffPath && (
            <div className="mt-1 break-all text-[11px] text-warning">{t('差异清单：')}{status.conflict.diffPath}</div>
          )}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStatus(await window.huAgent.sync.resolve('keep-local'))
                  setMessage(t('已将本地改动存入 .hu/sync/conflicts，并用服务端版本覆盖'))
                })
              }
              className="rounded-md bg-warning px-3 py-1.5 text-white hover:bg-warning disabled:opacity-40"
            >
              {t('保留本地副本后覆盖')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setStatus(await window.huAgent.sync.resolve('export-diff')))}
              className="rounded-md border border-warning px-3 py-1.5 disabled:opacity-40"
            >
              {t('导出差异清单')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setStatus(await window.huAgent.sync.resolve('cancel')))}
              className="rounded-md border border-warning px-3 py-1.5 disabled:opacity-40"
            >
              {t('取消')}
            </button>
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold text-fg-muted">{t('云端版本（保留最近 20 个，pinned 不计入）')}</h3>
        {versions.length === 0 ? (
          <p className="text-xs text-fg-subtle">{t('暂无快照（点击「立即同步」创建第一个版本）')}</p>
        ) : (
          <ul className="space-y-1">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    v{version.version}
                    {version.latest && (
                      <span className="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-[10px] text-success">{t('最新')}</span>
                    )}
                    {version.pinned && (
                      <span className="ml-2 rounded bg-accent-soft px-1.5 py-0.5 text-[10px] text-accent">{t('永久保留')}</span>
                    )}
                  </div>
                  <div className="truncate text-fg-subtle">
                    {version.fileCount} {t('个文件 ·')} {formatBytes(version.sizeBytes)} ·{' '}
                    {new Date(version.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!version.latest && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setStatus(await window.huAgent.sync.restore(version.version))
                          setMessage(t('已恢复到 v{version}（覆盖前已备份到 .hu/backups）', { version: version.version }))
                        })
                      }
                      className="text-accent hover:underline disabled:opacity-40"
                    >
                      {t('恢复')}
                    </button>
                  )}
                  {!version.pinned && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => window.huAgent.sync.pin(version.id))}
                      className="text-fg-muted hover:underline disabled:opacity-40"
                    >
                      {t('永久保留')}
                    </button>
                  )}
                  {!version.latest && !version.pinned && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => window.huAgent.sync.remove(version.id))}
                      className="text-danger hover:underline disabled:opacity-40"
                    >
                      {t('删除')}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
