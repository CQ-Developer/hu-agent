import { useCallback, useEffect, useState } from 'react'

interface Props {
  /** 服务端返回的失败原因（如会话被撤销、账号被禁用）或网络错误 */
  notice?: string | null
  /** true：存在本地登录态但服务端不可达（只可重试，不能绕过；ADR 0004 / D16） */
  retryOnly: boolean
  onLoggedIn: () => void
  onRetry: () => void
}

/** 启动登录门禁（design 4.1 + D16）：未登录不可进入主界面。 */
export default function LoginGate({ notice, retryOnly, onLoggedIn, onRetry }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [form, setForm] = useState({
    serverUrl: '',
    email: '',
    displayName: '',
    password: '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.huAgent.cloud.status().then((status) => {
      if (status.serverUrl) setForm((prev) => ({ ...prev, serverUrl: prev.serverUrl || status.serverUrl }))
    })
  }, [])

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'register' && !form.displayName.trim()) {
        throw new Error('注册需要填写昵称')
      }
      const status =
        mode === 'login'
          ? await window.huAgent.cloud.login(form.serverUrl, form.email, form.password)
          : await window.huAgent.cloud.register(
              form.serverUrl,
              form.email,
              form.displayName.trim(),
              form.password,
            )
      if (!status.loggedIn) throw new Error('登录状态异常，请重试')
      onLoggedIn()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [form, mode, onLoggedIn])

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-100 text-neutral-900">
      <div className="w-[460px] rounded-xl border border-neutral-200 bg-white p-8 shadow-sm">
        <div className="mb-1 text-lg font-semibold tracking-wide">hu-agent</div>
        <div className="mb-6 text-xs text-neutral-500">
          企业 Agent 平台 · 需注册登录后使用（本地 Agent、Skill、MCP 均要求有效账号）
        </div>

        {notice && (
          <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {notice}
            {retryOnly && <div className="mt-1 text-[11px]">当前保留了本地登录态，服务恢复后可直接重试。</div>}
          </div>
        )}

        <div className="mb-4 flex rounded-md bg-neutral-100 p-0.5 text-sm">
          {(['login', 'register'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`flex-1 rounded px-3 py-1.5 ${
                mode === item ? 'bg-white font-medium shadow-sm' : 'text-neutral-500 hover:text-neutral-800'
              }`}
            >
              {item === 'login' ? '登录' : '注册'}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <label className="block text-xs text-neutral-500">
            服务器地址
            <input
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm"
              placeholder="https://hu-agent.example.com"
              value={form.serverUrl}
              onChange={(event) => setForm({ ...form, serverUrl: event.target.value })}
            />
          </label>
          <label className="block text-xs text-neutral-500">
            邮箱
            <input
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </label>
          {mode === 'register' && (
            <label className="block text-xs text-neutral-500">
              昵称
              <input
                className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm"
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              />
            </label>
          )}
          <label className="block text-xs text-neutral-500">
            密码
            <input
              className="mt-1 w-full rounded border border-neutral-300 px-2 py-2 text-sm"
              type="password"
              placeholder={mode === 'register' ? '至少 10 位，不能是常见弱口令' : undefined}
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
          </label>
        </div>

        {error && <div className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="flex-1 rounded-md bg-neutral-900 px-3 py-2 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? '处理中…' : mode === 'login' ? '登录' : '注册并登录'}
          </button>
          {retryOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={onRetry}
              className="rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-100 disabled:opacity-40"
            >
              重试连接
            </button>
          )}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-neutral-400">
          登录态保存在本机（系统密钥库加密）；服务端不可用时无法进入应用，这是企业身份管控的要求。
        </p>
      </div>
    </div>
  )
}
