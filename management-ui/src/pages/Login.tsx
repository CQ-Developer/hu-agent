/** 登录页（design 7.2：公开页面）：同域部署，只需邮箱与密码。 */

import { Alert, Button, Card, Form, Input, Segmented, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router-dom'

import { useSession } from '../auth/SessionProvider'
import i18n from '../i18n'
import { errorText } from '../lib/errorText'

interface FormValues {
  email: string
  password: string
}

export default function Login() {
  const { t } = useTranslation()
  const { status, login } = useSession()
  const location = useLocation()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (status === 'ready') {
    const from = (location.state as { from?: string } | null)?.from ?? '/dashboard'
    return <Navigate to={from} replace />
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await login(values.email.trim(), values.password)
    } catch (cause) {
      setError(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <Card style={{ width: 380 }} title={t('login.title')}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {t('login.hint')}
        </Typography.Paragraph>
        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}
        <Form layout="vertical" onFinish={(values) => void onSubmit(values)} requiredMark={false}>
          <Form.Item
            name="email"
            label={t('login.email')}
            rules={[{ required: true, type: 'email', message: t('login.emailRequired') }]}
          >
            <Input autoComplete="username" placeholder="admin@example.com" />
          </Form.Item>
          <Form.Item
            name="password"
            label={t('login.password')}
            rules={[{ required: true, message: t('login.passwordRequired') }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={busy}>
            {t('login.submit')}
          </Button>
        </Form>
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center' }}>
          <Segmented
            size="small"
            value={i18n.language}
            onChange={(value) => void i18n.changeLanguage(String(value))}
            options={[
              { label: '中文', value: 'zh-CN' },
              { label: 'EN', value: 'en-US' },
            ]}
          />
        </div>
      </Card>
    </div>
  )
}
