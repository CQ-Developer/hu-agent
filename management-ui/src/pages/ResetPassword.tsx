/**
 * 重置密码公开页（design 7.2）：管理员签发的一次性链接落点。
 * 链接形如 `/reset-password?token=...`，令牌 24 小时有效、仅可使用一次。
 */

import { Alert, Button, Card, Form, Input, Segmented, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'

import { authApi } from '../api/endpoints'
import i18n from '../i18n'
import { errorText } from '../lib/errorText'

interface FormValues {
  password: string
  confirm: string
}

export default function ResetPassword() {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (values: FormValues): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await authApi.resetPassword(token, values.password)
      setDone(true)
    } catch (cause) {
      setError(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-page">
      <Card style={{ width: 380 }} title={t('resetPassword.title')}>
        {!token ? (
          <Alert type="error" showIcon title={t('resetPassword.invalidLink')} />
        ) : done ? (
          <>
            <Alert type="success" showIcon title={t('resetPassword.success')} style={{ marginBottom: 16 }} />
            <Link to="/login">
              <Button type="primary" block>
                {t('resetPassword.backToLogin')}
              </Button>
            </Link>
          </>
        ) : (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              {t('resetPassword.hint')}
            </Typography.Paragraph>
            {error && <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />}
            <Form layout="vertical" onFinish={(values) => void onSubmit(values)} requiredMark={false}>
              <Form.Item
                name="password"
                label={t('resetPassword.password')}
                rules={[{ required: true, min: 10, message: t('resetPassword.passwordRule') }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Form.Item
                name="confirm"
                label={t('resetPassword.confirm')}
                dependencies={['password']}
                rules={[
                  { required: true, message: t('resetPassword.confirmRequired') },
                  ({ getFieldValue }) => ({
                    validator: (_rule, value: string) =>
                      !value || getFieldValue('password') === value
                        ? Promise.resolve()
                        : Promise.reject(new Error(t('resetPassword.mismatch'))),
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
              <Button type="primary" htmlType="submit" block loading={busy}>
                {t('resetPassword.submit')}
              </Button>
            </Form>
          </>
        )}
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
