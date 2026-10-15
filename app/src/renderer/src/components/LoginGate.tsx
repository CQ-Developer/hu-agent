import { useCallback, useEffect, useState } from 'react'
import { t } from '../i18n'

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
  const [ssoProviders, setSsoProviders] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    void window.huAgent.cloud.status().then((status) => {
      if (status.serverUrl) setForm((prev) => ({ ...prev, serverUrl: prev.serverUrl || status.serverUrl }))
    })
  }, [])

  // 服务器地址可用时查询可用的 SSO 身份源（输入防抖 400ms）
  useEffect(() => {
    const serverUrl = form.serverUrl.trim()
    if (!/^https?:\/\//i.test(serverUrl)) {
      setSsoProviders([])
      return
    }
    const timer = setTimeout(() => {
      void window.huAgent.cloud
        .providers(serverUrl)
        .then((providers) =>
          setSsoProviders(
            providers
              .filter((provider) => provider.type === 'oidc' && provider.enabled)
              .map((provider) => ({ id: provider.id, name: provider.name })),
          ),
        )
        .catch(() => setSsoProviders([]))
    }, 400)
    return () => clearTimeout(timer)
  }, [form.serverUrl])

  const ssoLogin = useCallback(
    async (providerId: string): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const status = await window.huAgent.cloud.ssoLogin(form.serverUrl, providerId)
        if (!status.loggedIn) throw new Error(t('SSO 登录未完成'))
        onLoggedIn()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [form.serverUrl, onLoggedIn],
  )

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'register' && !form.displayName.trim()) {
        throw new Error(t('注册需要填写昵称'))
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
      if (!status.loggedIn) throw new Error(t('登录状态异常，请重试'))
      onLoggedIn()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [form, mode, onLoggedIn])

  return (
    <div className="flex h-screen w-screen items-center justify-center text-fg">
      <div className="glass w-[460px] p-8">
        <div className="mb-1 text-lg font-semibold tracking-wide">hu-agent</div>
        <div className="mb-6 text-xs text-fg-muted">
          {t('企业 Agent 平台 · 需注册登录后使用（本地 Agent、Skill、MCP 均要求有效账号）')}
        </div>

        {notice && (
          <div className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
            {notice}
            {retryOnly && <div className="mt-1 text-[11px]">{t('当前保留了本地登录态，服务恢复后可直接重试。')}</div>}
          </div>
        )}

        <div className="mb-4 flex rounded-chip bg-surface-2 p-1 text-sm">
          {(['login', 'register'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`flex-1 rounded-chip px-3 py-1.5 ${
                mode === item ? 'bg-surface-3 font-medium' : 'text-fg-muted hover:text-fg'
              }`}
            >
              {item === 'login' ? t('登录') : t('注册')}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          <label className="block text-xs text-fg-muted">
            {t('服务器地址')}
            <input
              className="ui-field mt-1"
              placeholder="https://hu-agent.example.com"
              value={form.serverUrl}
              onChange={(event) => setForm({ ...form, serverUrl: event.target.value })}
            />
          </label>

          {ssoProviders.length > 0 && (
            <div className="rounded-md border border-line bg-surface p-2">
              <div className="mb-1 text-[11px] text-fg-muted">{t('企业账号登录')}</div>
              {ssoProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void ssoLogin(provider.id)}
                  className="mb-1 w-full rounded-md border border-line-strong bg-surface-2 px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-40"
                >
                  {t('使用')} {provider.name} {t('登录')}
                </button>
              ))}
              <div className="text-[10px] text-fg-subtle">{t('将打开系统浏览器完成身份验证，完成后自动返回应用。')}</div>
            </div>
          )}
          <label className="block text-xs text-fg-muted">
            {t('邮箱')}
            <input
              className="ui-field mt-1"
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </label>
          {mode === 'register' && (
            <label className="block text-xs text-fg-muted">
              {t('昵称')}
              <input
                className="ui-field mt-1"
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              />
            </label>
          )}
          <label className="block text-xs text-fg-muted">
            {t('密码')}
            <input
              className="ui-field mt-1"
              type="password"
              placeholder={mode === 'register' ? t('至少 10 位，不能是常见弱口令') : undefined}
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit()
              }}
            />
          </label>
        </div>

        {error && <div className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-xs text-danger">{error}</div>}

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="ui-btn ui-btn-primary flex-1 py-2.5 text-small disabled:opacity-40"
          >
            {busy ? t('处理中…') : mode === 'login' ? t('登录') : t('注册并登录')}
          </button>
          {retryOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={onRetry}
              className="ui-btn ui-btn-glass px-4 py-2.5 text-small disabled:opacity-40"
            >
              {t('重试连接')}
            </button>
          )}
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-fg-subtle">
          {t('登录态保存在本机（系统密钥库加密）；服务端不可用时无法进入应用，这是企业身份管控的要求。')}
        </p>
      </div>
    </div>
  )
}
