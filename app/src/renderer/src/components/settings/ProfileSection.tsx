import { useCallback, useEffect, useState } from 'react'

import type { CloudDeviceView, CloudStatusView, UsageStatsView, WorkspaceInfoView } from '@shared/ipc'

interface Props {
  usage: UsageStatsView | null
  workspaces: WorkspaceInfoView[]
  activeWorkspace: WorkspaceInfoView | null
  onChanged?: () => void
}

export default function ProfileSection({ usage, workspaces, activeWorkspace, onChanged }: Props) {
  const [status, setStatus] = useState<CloudStatusView | null>(null)
  const [devices, setDevices] = useState<CloudDeviceView[]>([])
  const [form, setForm] = useState({ serverUrl: 'http://127.0.0.1:8080', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const next = await window.huAgent.cloud.status()
    setStatus(next)
    if (next.loggedIn) {
      try {
        setDevices(await window.huAgent.cloud.devices())
      } catch {
        setDevices([])
      }
    } else {
      setDevices([])
    }
    if (next.serverUrl) setForm((prev) => (prev.serverUrl ? prev : { ...prev, serverUrl: next.serverUrl }))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      await refresh()
      onChanged?.()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const login = (): Promise<void> =>
    run(async () => {
      setStatus(await window.huAgent.cloud.login(form.serverUrl, form.email, form.password))
      setForm((prev) => ({ ...prev, password: '' }))
    })

  const logout = (allDevices: boolean): Promise<void> =>
    run(async () => {
      setStatus(await window.huAgent.cloud.logout(allDevices))
    })

  const flush = (): Promise<void> =>
    run(async () => {
      const result = await window.huAgent.cloud.flush()
      setMessage(result.error ? `上报失败：${result.error}（待上报 ${result.pending} 条）` : `已上报 ${result.sent} 条，剩余 ${result.pending} 条`)
    })

  const clearQueue = (): Promise<void> =>
    run(async () => {
      setStatus(await window.huAgent.cloud.clearQueue())
      setMessage('已清空本工作空间的待上报队列')
    })

  return (
    <div className="space-y-5">
      <section className="rounded-lg border border-neutral-200 p-4">
        {status?.loggedIn && status.user ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-neutral-200 text-lg">👤</div>
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {status.user.displayName}
                  {status.user.isSystemAdmin && (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">系统管理员</span>
                  )}
                </div>
                <div className="truncate text-xs text-neutral-500">{status.user.email}</div>
                <div className="truncate text-[11px] text-neutral-400">{status.serverUrl}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={busy}
                onClick={() => void logout(false)}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-100 disabled:opacity-40"
              >
                退出登录
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void logout(true)}
                className="rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40"
              >
                全部设备下线
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-neutral-200 text-lg">👤</div>
              <div>
                <div className="text-sm font-medium">本地用户</div>
                <div className="text-xs text-neutral-400">未登录（本地 Agent 可用；上报与后续市场/同步需要登录）</div>
              </div>
            </div>
            <div className="grid gap-2 pt-1">
              <input
                className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
                placeholder="服务器地址（如 http://127.0.0.1:8080）"
                value={form.serverUrl}
                onChange={(event) => setForm({ ...form, serverUrl: event.target.value })}
              />
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm"
                  placeholder="邮箱"
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
                <input
                  className="flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm"
                  type="password"
                  placeholder="密码"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void login()
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void login()}
                  className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
                >
                  {busy ? '登录中…' : '登录'}
                </button>
                <span className="text-[11px] text-neutral-400">
                  设备指纹 {status?.deviceId.slice(0, 8) ?? '-'}…（首启动生成，登录时绑定）
                </span>
              </div>
            </div>
          </div>
        )}
        {message && <p className="mt-2 text-xs text-neutral-500">{message}</p>}
      </section>

      {status?.loggedIn && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-neutral-500">设备与安全</h3>
          <ul className="space-y-2">
            {devices.map((device) => (
              <li key={device.deviceId} className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium">
                    {device.name || device.deviceId.slice(0, 12)}
                    {device.current && (
                      <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">当前</span>
                    )}
                  </div>
                  <div className="truncate text-neutral-400">
                    {device.platform} · v{device.appVersion}
                    {device.lastSeenAt ? ` · 最后活跃 ${new Date(device.lastSeenAt).toLocaleString()}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(async () => setDevices(await window.huAgent.cloud.revokeDevice(device.deviceId)))}
                  className="shrink-0 text-rose-600 hover:underline disabled:opacity-40"
                >
                  吊销
                </button>
              </li>
            ))}
            {devices.length === 0 && <li className="text-xs text-neutral-400">暂无设备记录（登录后自动登记）</li>}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">用量上报</h3>
        <div className="rounded-lg border border-neutral-200 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              待上报：<b>{status?.pending ?? 0}</b> 条
            </span>
            <button
              type="button"
              disabled={busy || !status?.loggedIn}
              onClick={() => void flush()}
              className="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-40"
            >
              立即上报
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void clearQueue()}
              className="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-40"
            >
              清空队列
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
            上报只含模型/token/耗时/状态与设备、会话哈希（盐值本地随机），<b>不含提示词、回复内容、文件路径与工具参数</b>；
            队列存于 <code>&lt;workspace&gt;/.hu/telemetry/</code>，失败按 1m/5m/30m/2h 退避重试。
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">本地用量</h3>
        {usage ? (
          <div className="rounded-lg border border-neutral-200 p-3">
            <div className="flex gap-6 text-xs">
              <div>
                <div className="text-neutral-400">调用次数</div>
                <div className="text-lg">{usage.calls}</div>
              </div>
              <div>
                <div className="text-neutral-400">输入 tokens</div>
                <div className="text-lg">{usage.inputTokens}</div>
              </div>
              <div>
                <div className="text-neutral-400">输出 tokens</div>
                <div className="text-lg">{usage.outputTokens}</div>
              </div>
              <div>
                <div className="text-neutral-400">失败</div>
                <div className="text-lg">{usage.errors}</div>
              </div>
            </div>
            {Object.keys(usage.byModel).length > 0 && (
              <table className="mt-3 w-full text-xs">
                <thead className="text-left text-neutral-400">
                  <tr>
                    <th className="py-1">模型</th>
                    <th>调用</th>
                    <th>输入</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(usage.byModel).map(([model, item]) => (
                    <tr key={model} className="border-t border-neutral-100">
                      <td className="py-1 font-mono">{model}</td>
                      <td>{item.calls}</td>
                      <td>{item.inputTokens}</td>
                      <td>{item.outputTokens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="text-xs text-neutral-400">暂无用量记录</p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">工作空间</h3>
        <div className="rounded-lg border border-neutral-200 p-3 text-xs">
          <div>
            共 {workspaces.length} 个，当前：{activeWorkspace?.name ?? '-'}
          </div>
          {activeWorkspace && <div className="mt-1 truncate text-neutral-400">{activeWorkspace.root}</div>}
        </div>
      </section>
    </div>
  )
}
