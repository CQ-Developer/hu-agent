/** SSO 回调页（design 6.12.3）：用 code + PKCE verifier 换本地令牌后进入概览。 */

import { Spin, Result, Button } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { completeSsoLogin } from '../auth/sso'
import { useSession } from '../auth/SessionProvider'
import { errorText } from '../lib/errorText'

export default function SsoCallback() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { reloadProfile } = useSession()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state') ?? ''
    const failure = params.get('error')

    if (failure) {
      setError(params.get('error_description') ?? failure)
      return
    }
    if (!code) {
      setError(t('sso.missingCode'))
      return
    }
    void (async () => {
      try {
        await completeSsoLogin(code, state)
        // 会话已建立：刷新会话状态并进入概览
        window.location.replace('/dashboard')
      } catch (cause) {
        setError(errorText(cause, t))
      }
    })()
  }, [t, navigate, reloadProfile])

  if (error) {
    return (
      <Result
        status="error"
        title={t('sso.failed')}
        subTitle={error}
        extra={
          <Button type="primary" onClick={() => window.location.replace('/login')}>
            {t('sso.backToLogin')}
          </Button>
        }
      />
    )
  }
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 160 }}>
      <Spin size="large" />
    </div>
  )
}
