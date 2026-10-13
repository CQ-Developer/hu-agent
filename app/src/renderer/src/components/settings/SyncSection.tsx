import { useCallback, useEffect, useState } from 'react'

import type { SyncSettingsView, SyncStatusView, SyncVersionView } from '@shared/ipc'

const STATUS_LABEL: Record<string, string> = {
  unlinked: '未关联服务端工作空间',
  'up-to-date': '已是最新',
  'local-changes': '有本地改动待上传',
  'remote-changes': '服务端有新版本',
  conflict: '存在冲突，需人工处理',
  error: '同步异常',
}

const SCHEDULE_OPTIONS: { value: SyncSettingsView['schedule']; label: string }[] = [
  { value: 'off', label: '关闭' },
  { value: '15m', label: '每 15 分钟' },
  { value: '30m', label: '每 30 分钟' },
  { value: '1h', label: '每 1 小时' },
  { value: '6h', label: '每 6 小时' },
  { value: '24h', label: '每 24 小时' },
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
      <p className="text-[11px] leading-relaxed text-neutral-400">
        快照为整体 zip（不做文件级合并）：上传走预签名直传对象存储，服务端校验 sha256；
        排除 <code>.hu/sync</code>、<code>.hu/logs</code>、<code>.hu/backups</code>、<code>node_modules</code>、
        <code>.git</code>、<code>dist</code>、<code>.venv</code>（可在 <code>.hu/workspace.json</code> 的{' '}
        <code>syncExclude</code> 追加）。只有工作空间所有者可以读写快照。
      </p>

      <section className="rounded-lg border border-neutral-200 p-4">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="rounded bg-neutral-100 px-2 py-1">{status ? STATUS_LABEL[status.status] : '读取中…'}</span>
          {status?.lastVersion !== undefined && <span>版本 v{status.lastVersion}</span>}
          {status?.lastSyncedAt && <span className="text-neutral-400">上次同步 {new Date(status.lastSyncedAt).toLocaleString()}</span>}
          <span className="text-neutral-400">
            本地 {status?.localFiles ?? 0} 个文件 / {formatBytes(status?.localBytes ?? 0)}
          </span>
          {status?.remoteVersion !== undefined && <span className="text-neutral-400">服务端 v{status.remoteVersion}</span>}
        </div>

        {status?.lastError && (
          <div className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {status.lastError}
            {(settings?.consecutiveFailures ?? 0) >= 3 && (
              <span className="ml-1 font-medium">（已连续失败 {settings?.consecutiveFailures} 次，请检查网络或服务端）</span>
            )}
          </div>
        )}

        {quota && (
          <div className="mt-3">
            <div className="flex justify-between text-[11px] text-neutral-500">
              <span>存储用量</span>
              <span>
                {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)}
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full rounded-full bg-neutral-200">
              <div className="h-1.5 rounded-full bg-neutral-900" style={{ width: `${quotaPercent}%` }} />
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
                setMessage(`同步完成：${STATUS_LABEL[result.status] ?? result.status}`)
              })
            }
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? '同步中…' : '立即同步'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(async () => setStatus(await window.huAgent.sync.status()))}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-40"
          >
            刷新状态
          </button>
          <label className="flex items-center gap-2 text-xs text-neutral-600">
            定时同步
            <select
              className="rounded border border-neutral-300 px-2 py-1"
              value={settings?.schedule ?? 'off'}
              onChange={(event) =>
                void run(async () => {
                  setSettings(
                    await window.huAgent.sync.setSettings({
                      schedule: event.target.value as SyncSettingsView['schedule'],
                      includeSessions: settings?.includeSessions !== false,
                    }),
                  )
                })
              }
            >
              {SCHEDULE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {message && <p className="mt-2 text-xs text-neutral-500">{message}</p>}
      </section>

      {status?.conflict && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="text-sm font-medium text-amber-900">本地与服务端都有改动，已暂停自动处理</div>
          <div className="mt-1 text-xs text-amber-800">
            服务端 v{status.conflict.remoteVersion}；本地 {status.conflict.localFiles} 个文件。
            新增 {status.conflict.diff.added.length}、修改 {status.conflict.diff.modified.length}、删除{' '}
            {status.conflict.diff.removed.length} 个文件。
          </div>
          {status.conflict.diffPath && (
            <div className="mt-1 break-all text-[11px] text-amber-700">差异清单：{status.conflict.diffPath}</div>
          )}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStatus(await window.huAgent.sync.resolve('keep-local'))
                  setMessage('已将本地改动存入 .hu/sync/conflicts，并用服务端版本覆盖')
                })
              }
              className="rounded-md bg-amber-700 px-3 py-1.5 text-white hover:bg-amber-600 disabled:opacity-40"
            >
              保留本地副本后覆盖
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setStatus(await window.huAgent.sync.resolve('export-diff')))}
              className="rounded-md border border-amber-400 px-3 py-1.5 disabled:opacity-40"
            >
              导出差异清单
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setStatus(await window.huAgent.sync.resolve('cancel')))}
              className="rounded-md border border-amber-400 px-3 py-1.5 disabled:opacity-40"
            >
              取消
            </button>
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">云端版本（保留最近 20 个，pinned 不计入）</h3>
        {versions.length === 0 ? (
          <p className="text-xs text-neutral-400">暂无快照（点击「立即同步」创建第一个版本）</p>
        ) : (
          <ul className="space-y-1">
            {versions.map((version) => (
              <li
                key={version.id}
                className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    v{version.version}
                    {version.latest && (
                      <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">最新</span>
                    )}
                    {version.pinned && (
                      <span className="ml-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] text-blue-700">永久保留</span>
                    )}
                  </div>
                  <div className="truncate text-neutral-400">
                    {version.fileCount} 个文件 · {formatBytes(version.sizeBytes)} ·{' '}
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
                          setMessage(`已恢复到 v${version.version}（覆盖前已备份到 .hu/backups）`)
                        })
                      }
                      className="text-blue-600 hover:underline disabled:opacity-40"
                    >
                      恢复
                    </button>
                  )}
                  {!version.pinned && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => window.huAgent.sync.pin(version.id))}
                      className="text-neutral-600 hover:underline disabled:opacity-40"
                    >
                      永久保留
                    </button>
                  )}
                  {!version.latest && !version.pinned && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void run(async () => window.huAgent.sync.remove(version.id))}
                      className="text-rose-600 hover:underline disabled:opacity-40"
                    >
                      删除
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
