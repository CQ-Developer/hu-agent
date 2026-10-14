/** 个人设置（design 7.2）：昵称、语言、设备与安全、SSO 绑定。 */

import { App as AntApp, Alert, Button, Card, Descriptions, Form, Input, Popconfirm, Select, Space, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { meApi, type Device, type Identity, type Notification } from '../api/endpoints'
import { useSession } from '../auth/SessionProvider'
import { useAsync } from '../lib/useAsync'
import { formatDateTime } from '../lib/format'
import { errorText } from '../lib/errorText'
export default function Profile() {
  const { message } = AntApp.useApp()
  const { t, i18n } = useTranslation()
  const { profile, patchProfile, logout } = useSession()
  const [displayName, setDisplayName] = useState(profile?.displayName ?? '')
  const [locale, setLocale] = useState<'zh-CN' | 'en-US'>((profile?.locale as 'zh-CN' | 'en-US') ?? 'zh-CN')
  const [busy, setBusy] = useState(false)

  const devices = useAsync(() => meApi.devices(), [])
  const identities = useAsync(() => meApi.identities(), [])
  const notifications = useAsync(() => meApi.notifications(), [])

  useEffect(() => {
    setDisplayName(profile?.displayName ?? '')
    if (profile?.locale) setLocale(profile.locale as 'zh-CN' | 'en-US')
  }, [profile?.displayName, profile?.locale])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await patchProfile({ displayName: displayName.trim(), locale })
      void i18n.changeLanguage(locale)
      void message.success(t('profile.saved'))
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const revokeDevice = async (id: string): Promise<void> => {
    try {
      await meApi.revokeDevice(id)
      void message.success(t('profile.saved'))
      await devices.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    }
  }

  const unlink = async (id: string): Promise<void> => {
    try {
      await meApi.unlinkIdentity(id)
      void message.success(t('profile.saved'))
      await identities.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    }
  }

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Card title={t('profile.title')}>
        <Form layout="vertical" style={{ maxWidth: 420 }}>
          <Form.Item label={t('profile.displayName')}>
            <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </Form.Item>
          <Form.Item label={t('profile.locale')}>
            <Select
              value={locale}
              onChange={(value: 'zh-CN' | 'en-US') => setLocale(value)}
              options={[
                { value: 'zh-CN', label: '简体中文' },
                { value: 'en-US', label: 'English' },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" loading={busy} onClick={() => void save()}>
                {t('profile.save')}
              </Button>
              <Popconfirm
                title={t('profile.signOutAllConfirm')}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
                onConfirm={() => void logout()}
              >
                <Button danger>{t('profile.signOutAll')}</Button>
              </Popconfirm>
            </Space>
          </Form.Item>
        </Form>
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="Email">{profile?.email}</Descriptions.Item>
          <Descriptions.Item label="ID">{profile?.id}</Descriptions.Item>
          <Descriptions.Item label={t('dashboard.unreadNotifications')}>
            {notifications.data?.unread ?? 0}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title={t('profile.devices')}
        extra={
          <Button
            size="small"
            onClick={() => {
              void meApi.markNotifications(true)
            }}
          >
            {t('common.refresh')}
          </Button>
        }
      >
        {devices.error && <Alert type="error" showIcon title={devices.error} style={{ marginBottom: 12 }} />}
        <Table<Device>
          size="small"
          rowKey="id"
          loading={devices.loading}
          dataSource={devices.data?.devices ?? []}
          pagination={false}
          columns={[
            { title: t('profile.deviceId'), dataIndex: 'deviceId' },
            { title: t('profile.platform'), dataIndex: 'platform' },
            { title: t('profile.appVersion'), dataIndex: 'appVersion' },
            {
              title: t('profile.lastSeen'),
              dataIndex: 'lastSeenAt',
              render: (value: string | null) => formatDateTime(value, i18n.language),
            },
            {
              title: '',
              dataIndex: 'current',
              render: (value: boolean) => (value ? <Tag color="green">{t('profile.current')}</Tag> : null),
            },
            {
              title: t('common.actions'),
              render: (_: unknown, row: Device) => (
                <Popconfirm
                  title={t('profile.revokeConfirm')}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                  onConfirm={() => void revokeDevice(row.id)}
                >
                  <Button size="small" type="link" danger disabled={row.current}>
                    {t('profile.revoke')}
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Card title={t('profile.identities')}>
        <Alert type="info" showIcon title={t('profile.unlinkHint')} style={{ marginBottom: 12 }} />
        {identities.error && <Alert type="error" showIcon title={identities.error} style={{ marginBottom: 12 }} />}
        <Table<Identity>
          size="small"
          rowKey="id"
          loading={identities.loading}
          dataSource={identities.data ?? []}
          pagination={false}
          columns={[
            { title: t('profile.identityProvider'), dataIndex: 'providerName' },
            { title: t('profile.identityEmail'), dataIndex: 'email', render: (value: string | null) => value ?? '-' },
            {
              title: t('profile.identityLastLogin'),
              dataIndex: 'lastLoginAt',
              render: (value: string | null) => formatDateTime(value, i18n.language),
            },
            {
              title: t('common.actions'),
              render: (_: unknown, row: Identity) => (
                <Popconfirm
                  title={t('profile.unlinkConfirm')}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                  onConfirm={() => void unlink(row.id)}
                >
                  <Button size="small" type="link" danger>
                    {t('profile.unlink')}
                  </Button>
                </Popconfirm>
              ),
            },
          ]}
        />
      </Card>

      <Card title={t('notifications.title')}>
        <Table<Notification>
          size="small"
          rowKey="id"
          loading={notifications.loading}
          dataSource={notifications.data?.items ?? []}
          pagination={false}
          columns={[
            { title: t('common.status'), dataIndex: 'title' },
            { title: '', dataIndex: 'body' },
            {
              title: t('common.createdAt'),
              dataIndex: 'createdAt',
              render: (value: string) => formatDateTime(value, i18n.language),
            },
          ]}
        />
      </Card>
    </Space>
  )
}
