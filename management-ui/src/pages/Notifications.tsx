/**
 * 通知中心（design 7.2 个人区）：全部通知 + 未读筛选 + 一键已读。
 */

import { CheckOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, App as AntApp, Button, Card, Segmented, Space, Table, Tag } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { meApi, type Notification } from '../api/endpoints'
import { useAsync } from '../lib/useAsync'
import { errorText } from '../lib/errorText'
import { formatDateTime } from '../lib/format'

export default function Notifications() {
  const { t, i18n } = useTranslation()
  const { message } = AntApp.useApp()
  const [unreadOnly, setUnreadOnly] = useState(false)
  const notifications = useAsync(() => meApi.notifications(unreadOnly), [unreadOnly])

  const markAll = async (): Promise<void> => {
    try {
      await meApi.markNotifications(true)
      message.success(t('notifications.markedAll'))
      await notifications.reload()
    } catch (cause) {
      message.error(errorText(cause, t))
    }
  }

  return (
    <Card
      title={t('notifications.title')}
      extra={
        <Space>
          <Tag>{`${t('notifications.unread')}: ${notifications.data?.unread ?? 0}`}</Tag>
          <Button icon={<CheckOutlined />} onClick={() => void markAll()} disabled={!notifications.data?.unread}>
            {t('notifications.markAllRead')}
          </Button>
          <Button icon={<ReloadOutlined />} loading={notifications.loading} onClick={() => void notifications.reload()}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      <Segmented
        size="small"
        style={{ marginBottom: 12 }}
        value={unreadOnly ? 'unread' : 'all'}
        onChange={(value) => setUnreadOnly(String(value) === 'unread')}
        options={[
          { label: t('common.all'), value: 'all' },
          { label: t('notifications.unreadOnly'), value: 'unread' },
        ]}
      />
      {notifications.error && <Alert type="error" showIcon title={notifications.error} style={{ marginBottom: 12 }} />}
      <Table<Notification>
        size="small"
        rowKey="id"
        loading={notifications.loading}
        dataSource={notifications.data?.items ?? []}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: t('notifications.type'), dataIndex: 'type' },
          { title: t('notifications.titleColumn'), dataIndex: 'title' },
          { title: t('notifications.body'), dataIndex: 'body' },
          {
            title: t('common.status'),
            dataIndex: 'readAt',
            render: (value: string | null) => (value ? <Tag>{t('notifications.read')}</Tag> : <Tag color="processing">{t('notifications.unreadTag')}</Tag>),
          },
          {
            title: t('common.createdAt'),
            dataIndex: 'createdAt',
            render: (value: string) => formatDateTime(value, i18n.language),
          },
        ]}
      />
    </Card>
  )
}
