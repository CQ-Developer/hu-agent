import { useCallback, useEffect, useState } from 'react'

import type {
  CloudDeviceView,
  CloudStatusView,
  LocalePreferenceView,
  LocaleView,
  UsageStatsView,
  WorkspaceInfoView,
} from '@shared/ipc'
import { applyResolved, t } from '../../i18n'

/** 语言设置（design 5.13 / D13）：默认跟随系统，切换后立即生效并同步到服务端（通知/邮件用）。 */
/** 数据与隐私（design 6.10.5）：导出本人数据、申请注销账号。 */
function DataAndPrivacy() {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState('')
  const [password, setPassword] = useState('')
  const [purgeInfo, setPurgeInfo] = useState<string | null>(null)

  const exportData = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.huAgent.cloud.exportData()
      if (!result.canceled) setMessage(t('已导出到 {0}', { 0: result.path ?? '' }))
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const requestDeletion = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.huAgent.cloud.deleteAccount(confirmEmail.trim(), password || undefined)
      setPurgeInfo(result.purgeAfter.slice(0, 10))
      setDeleteOpen(false)
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-neutral-500">{t('数据与隐私')}</h3>
      <div className="space-y-2 rounded-lg border border-neutral-200 p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void exportData()}
            className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-50"
          >
            {t('导出我的数据（JSON）')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDeleteOpen(true)
              setConfirmEmail('')
              setPassword('')
            }}
            className="rounded-md border border-rose-300 bg-white px-2.5 py-1 text-rose-600 hover:bg-rose-50 disabled:opacity-50"
          >
            {t('注销账号')}
          </button>
          <span className="text-neutral-400">{t('导出包含资料、设备、通知、激活与用量日聚合；不含他人数据')}</span>
        </div>
        {message && <div className="text-emerald-600">{message}</div>}
        {purgeInfo && (
          <div className="text-rose-600">
            {t('注销申请已提交：账号已停用，数据将于 {0} 后清理；本地工作空间文件需自行删除', { 0: purgeInfo })}
          </div>
        )}
        {error && <div className="text-rose-600">{error}</div>}
      </div>

      {deleteOpen && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40">
          <div className="w-[420px] rounded-xl bg-white p-4 text-xs shadow-2xl">
            <div className="mb-2 text-sm font-semibold">{t('注销账号')}</div>
            <p className="mb-3 text-neutral-600">
              {t('注销后立即无法登录，全部设备会话被撤销；{0} 天后清理账号信息（邮箱、昵称、身份绑定、设备与通知），用量统计改为匿名保留。此操作不可自助撤销。', {
                0: 30,
              })}
            </p>
            <label className="mb-1 block text-neutral-500">{t('输入账号邮箱以确认')}</label>
            <input
              className="mb-2 w-full rounded border border-neutral-300 px-2 py-1"
              value={confirmEmail}
              onChange={(event) => setConfirmEmail(event.target.value)}
              placeholder="you@example.com"
            />
            <label className="mb-1 block text-neutral-500">{t('密码（SSO 账号可留空）')}</label>
            <input
              type="password"
              className="mb-3 w-full rounded border border-neutral-300 px-2 py-1"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error && <div className="mb-2 text-rose-600">{error}</div>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteOpen(false)}
                className="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100"
              >
                {t('取消')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void requestDeletion()}
                className="rounded-md bg-rose-600 px-2.5 py-1 text-white hover:bg-rose-500 disabled:opacity-50"
              >
                {t('确认注销')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function LocaleSetting() {
  const [locale, setLocale] = useState<LocaleView | null>(null)

  useEffect(() => {
    void window.huAgent.settings.getLocale().then(setLocale)
  }, [])

  const change = async (preference: LocalePreferenceView): Promise<void> => {
    const next = await window.huAgent.settings.setLocale(preference)
    applyResolved(next.preference, next.resolved)
    setLocale(next)
    // 同步 users.locale：失败不影响本地切换
    void window.huAgent.cloud.updateLocale(next.resolved).catch(() => undefined)
  }

  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold text-neutral-500">{t('语言')}</h3>
      <div className="flex items-center gap-2 text-xs">
        <select
          className="rounded border border-neutral-300 bg-white px-2 py-1"
          value={locale?.preference ?? 'system'}
          onChange={(event) => void change(event.target.value as LocalePreferenceView)}
        >
          <option value="system">{t('跟随系统（{0}）', { 0: locale?.system === 'en-US' ? 'English' : t('中文') })}</option>
          <option value="zh-CN">{t('简体中文')}</option>
          <option value="en-US">English</option>
        </select>
        <span className="text-neutral-400">{t('切换语言立即生效，并用于通知与邮件')}</span>
      </div>
    </section>
  )
}

interface Props {
  usage: UsageStatsView | null
  workspaces: WorkspaceInfoView[]
  activeWorkspace: WorkspaceInfoView | null
  onChanged?: () => void
}

export default function ProfileSection({ usage, workspaces, activeWorkspace, onChanged }: Props) {
  const [status, setStatus] = useState<CloudStatusView | null>(null)
  const [devices, setDevices] = useState<CloudDeviceView[]>([])
  const [form, setForm] = useState({ serverUrl: 'http://127.0.0.1:8080', email: '', password: '', displayName: '' })
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

  const register = (): Promise<void> =>
    run(async () => {
      if (!form.displayName.trim()) {
        setMessage(t('注册需要填写昵称'))
        return
      }
      setStatus(
        await window.huAgent.cloud.register(form.serverUrl, form.email, form.displayName.trim(), form.password),
      )
      setForm((prev) => ({ ...prev, password: '' }))
    })

  const logout = (allDevices: boolean): Promise<void> =>
    run(async () => {
      setStatus(await window.huAgent.cloud.logout(allDevices))
    })

  const flush = (): Promise<void> =>
    run(async () => {
      const result = await window.huAgent.cloud.flush()
      setMessage(result.error ? t('上报失败：{error}（待上报 {pending} 条）', { error: result.error, pending: result.pending }) : t('已上报 {sent} 条，剩余 {pending} 条', { sent: result.sent, pending: result.pending }))
    })

  const clearQueue = (): Promise<void> =>
    run(async () => {
      setStatus(await window.huAgent.cloud.clearQueue())
      setMessage(t('已清空本工作空间的待上报队列'))
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
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">{t('系统管理员')}</span>
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
                {t('退出登录')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void logout(true)}
                className="rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40"
              >
                {t('全部设备下线')}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-full bg-neutral-200 text-lg">👤</div>
              <div>
                <div className="text-sm font-medium">{t('本地用户')}</div>
                <div className="text-xs text-neutral-400">{t('未登录（本地 Agent 可用；上报与后续市场/同步需要登录）')}</div>
              </div>
            </div>
            <div className="grid gap-2 pt-1">
              <input
                className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
                placeholder={t("服务器地址（如 http://127.0.0.1:8080）")}
                value={form.serverUrl}
                onChange={(event) => setForm({ ...form, serverUrl: event.target.value })}
              />
              <div className="flex gap-2">
                <input
                  className="flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm"
                  placeholder={t("邮箱")}
                  value={form.email}
                  onChange={(event) => setForm({ ...form, email: event.target.value })}
                />
                <input
                  className="flex-1 rounded border border-neutral-300 px-2 py-1.5 text-sm"
                  placeholder={t("昵称（注册时用）")}
                  value={form.displayName}
                  onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                />
              </div>
              <input
                className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
                type="password"
                placeholder={t("密码（至少 10 位，不能是常见弱口令）")}
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void login()
                }}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void login()}
                  className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
                >
                  {busy ? t('登录中…') : t('登录')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void register()}
                  className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 disabled:opacity-40"
                >
                  {t('注册并登录')}
                </button>
                <span className="text-[11px] text-neutral-400">
                  {t('设备指纹')} {status?.deviceId.slice(0, 8) ?? '-'}{t('…（首启动生成，登录时绑定）')}
                </span>
              </div>
            </div>
          </div>
        )}
        {message && <p className="mt-2 text-xs text-neutral-500">{message}</p>}
      </section>

      {status?.loggedIn && (
        <section>
          <h3 className="mb-2 text-xs font-semibold text-neutral-500">{t('设备与安全')}</h3>
          <ul className="space-y-2">
            {devices.map((device) => (
              <li key={device.deviceId} className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-xs">
                <div className="min-w-0">
                  <div className="font-medium">
                    {device.name || device.deviceId.slice(0, 12)}
                    {device.current && (
                      <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">{t('当前')}</span>
                    )}
                  </div>
                  <div className="truncate text-neutral-400">
                    {device.platform} · v{device.appVersion}
                    {device.lastSeenAt ? t(' · 最后活跃 {0}', { 0: new Date(device.lastSeenAt).toLocaleString() }) : ''}
                  </div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(async () => setDevices(await window.huAgent.cloud.revokeDevice(device.deviceId)))}
                  className="shrink-0 text-rose-600 hover:underline disabled:opacity-40"
                >
                  {t('吊销')}
                </button>
              </li>
            ))}
            {devices.length === 0 && <li className="text-xs text-neutral-400">{t('暂无设备记录（登录后自动登记）')}</li>}
          </ul>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">{t('用量上报')}</h3>
        <div className="rounded-lg border border-neutral-200 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <span>
              {t('待上报：')}<b>{status?.pending ?? 0}</b> {t('条')}
            </span>
            <button
              type="button"
              disabled={busy || !status?.loggedIn}
              onClick={() => void flush()}
              className="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-40"
            >
              {t('立即上报')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void clearQueue()}
              className="rounded-md border border-neutral-300 px-2.5 py-1 hover:bg-neutral-100 disabled:opacity-40"
            >
              {t('清空队列')}
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">
            {t('上报只含模型/token/耗时/状态与设备、会话哈希（盐值本地随机），')}<b>{t('不含提示词、回复内容、文件路径与工具参数')}</b>{t('； 队列存于')} <code>&lt;workspace&gt;/.hu/telemetry/</code>{t('，失败按 1m/5m/30m/2h 退避重试。')}
          </p>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">{t('本地用量')}</h3>
        {usage ? (
          <div className="rounded-lg border border-neutral-200 p-3">
            <div className="flex gap-6 text-xs">
              <div>
                <div className="text-neutral-400">{t('调用次数')}</div>
                <div className="text-lg">{usage.calls}</div>
              </div>
              <div>
                <div className="text-neutral-400">{t('输入 tokens')}</div>
                <div className="text-lg">{usage.inputTokens}</div>
              </div>
              <div>
                <div className="text-neutral-400">{t('输出 tokens')}</div>
                <div className="text-lg">{usage.outputTokens}</div>
              </div>
              <div>
                <div className="text-neutral-400">{t('失败')}</div>
                <div className="text-lg">{usage.errors}</div>
              </div>
            </div>
            {Object.keys(usage.byModel).length > 0 && (
              <table className="mt-3 w-full text-xs">
                <thead className="text-left text-neutral-400">
                  <tr>
                    <th className="py-1">{t('模型')}</th>
                    <th>{t('调用')}</th>
                    <th>{t('输入')}</th>
                    <th>{t('输出')}</th>
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
          <p className="text-xs text-neutral-400">{t('暂无用量记录')}</p>
        )}
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">{t('工作空间')}</h3>
        <div className="rounded-lg border border-neutral-200 p-3 text-xs">
          <div>
            {t('共')} {workspaces.length} {t('个，当前：')}{activeWorkspace?.name ?? '-'}
          </div>
          {activeWorkspace && <div className="mt-1 truncate text-neutral-400">{activeWorkspace.root}</div>}
        </div>
      </section>

      <LocaleSetting />

      <DataAndPrivacy />

    </div>
  )
}
