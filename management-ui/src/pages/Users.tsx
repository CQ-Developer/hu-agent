/**
 * 用户管理页（design 7.2 系统区，系统管理员）：检索/状态筛选、禁用与启用、强制下线、
 * 注销宽限期恢复、签发一次性密码重置链接（明文仅展示一次）。
 */

import { CopyOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { adminApi, type AdminUser } from '../api/endpoints'
import { useSession } from '../auth/SessionProvider'
import { errorText } from '../lib/errorText'
import { formatDateTime } from '../lib/format'
import { useAsync } from '../lib/useAsync'

type StatusFilter = 'active' | 'disabled' | 'pending_deletion'

const PAGE_SIZE = 20

/** 重置链接落在管理台公开页 `/reset-password`；按部署基路径拼接 */
function resetUrl(token: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`
  return `${window.location.origin}${base}reset-password?token=${encodeURIComponent(token)}`
}

export default function Users() {
  const { message } = AntApp.useApp()
  const { t, i18n } = useTranslation()
  const { profile } = useSession()
  const [query, setQuery] = useState('')
  const [keyword, setKeyword] = useState('')
  const [status, setStatus] = useState<StatusFilter | undefined>()
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null)
  const [disableReason, setDisableReason] = useState('')
  const [resetResult, setResetResult] = useState<{ email: string; url: string; expiresAt: string } | null>(null)

  const users = useAsync(
    () => adminApi.users({ q: keyword, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    [keyword, status, page],
  )

  const run = async (action: () => Promise<unknown>, successText: string): Promise<void> => {
    setBusy(true)
    try {
      await action()
      void message.success(successText)
      await users.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async (row: AdminUser): Promise<void> => {
    setBusy(true)
    try {
      const issued = await adminApi.resetUserPassword(row.id)
      setResetResult({ email: row.email, url: resetUrl(issued.token), expiresAt: issued.expiresAt })
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const forceLogout = async (row: AdminUser): Promise<void> => {
    setBusy(true)
    try {
      const result = await adminApi.forceLogoutUser(row.id)
      void message.success(t('users.forceLogoutDone', { count: result.revoked }))
      await users.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const statusTag = (row: AdminUser) => {
    if (row.purgedAt) return <Tag>{t('users.statusPurged')}</Tag>
    if (row.deletionRequestedAt) return <Tag color="orange">{t('users.statusPendingDeletion')}</Tag>
    return row.status === 'active' ? (
      <Tag color="green">{t('users.statusActive')}</Tag>
    ) : (
      <Tag color="red">{t('users.statusDisabled')}</Tag>
    )
  }

  return (
    <Card
      title={t('menu.users')}
      extra={
        <Space>
          <Tag>{`${t('common.total')}: ${users.data?.total ?? 0}`}</Tag>
          <Button icon={<ReloadOutlined />} loading={users.loading} onClick={() => void users.reload()}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Input.Search
          allowClear
          style={{ width: 280 }}
          placeholder={t('users.searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onSearch={(value) => {
            setKeyword(value.trim())
            setPage(1)
          }}
        />
        <Select
          style={{ width: 180 }}
          value={status ?? ''}
          onChange={(value) => {
            setStatus(value === '' ? undefined : (value as StatusFilter))
            setPage(1)
          }}
          options={[
            { value: '', label: t('users.statusAll') },
            { value: 'active', label: t('users.statusActive') },
            { value: 'disabled', label: t('users.statusDisabled') },
            { value: 'pending_deletion', label: t('users.statusPendingDeletion') },
          ]}
        />
      </Space>

      {users.error && <Alert type="error" showIcon title={users.error} style={{ marginBottom: 12 }} />}

      <Table<AdminUser>
        size="small"
        rowKey="id"
        loading={users.loading}
        dataSource={users.data?.items ?? []}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: users.data?.total ?? 0,
          showSizeChanger: false,
          onChange: setPage,
        }}
        columns={[
          { title: t('members.email'), dataIndex: 'email' },
          {
            title: t('members.displayName'),
            dataIndex: 'displayName',
            render: (value: string, row) => (
              <Space size={4}>
                <span>{value}</span>
                {row.isSystemAdmin && <Tag color="gold">{t('common.systemAdmin')}</Tag>}
                {row.id === profile?.id && <Tag>{t('users.self')}</Tag>}
              </Space>
            ),
          },
          { title: t('common.status'), render: (_: unknown, row) => statusTag(row) },
          {
            title: t('users.password'),
            dataIndex: 'hasPassword',
            render: (value: boolean) => (value ? t('users.hasPassword') : <Tag>{t('users.noPassword')}</Tag>),
          },
          {
            title: t('common.createdAt'),
            dataIndex: 'createdAt',
            render: (value: string) => formatDateTime(value, i18n.language),
          },
          {
            title: t('common.actions'),
            render: (_: unknown, row) => {
              const pendingDeletion = Boolean(row.deletionRequestedAt && !row.purgedAt)
              return (
                <Space size={4} wrap>
                  {row.status === 'active' && !pendingDeletion && !row.purgedAt && (
                    <Button
                      size="small"
                      type="link"
                      danger
                      disabled={row.id === profile?.id || busy}
                      onClick={() => {
                        setDisableReason('')
                        setDisableTarget(row)
                      }}
                    >
                      {t('users.disable')}
                    </Button>
                  )}
                  {row.status === 'disabled' && !pendingDeletion && !row.purgedAt && (
                    <Button
                      size="small"
                      type="link"
                      disabled={busy}
                      onClick={() => void run(() => adminApi.enableUser(row.id), t('users.enabled'))}
                    >
                      {t('users.enable')}
                    </Button>
                  )}
                  {pendingDeletion && (
                    <Popconfirm
                      title={t('users.restoreConfirm')}
                      okText={t('common.confirm')}
                      cancelText={t('common.cancel')}
                      onConfirm={() => void run(() => adminApi.restoreUser(row.id), t('users.restored'))}
                    >
                      <Button size="small" type="link" disabled={busy}>
                        {t('users.restore')}
                      </Button>
                    </Popconfirm>
                  )}
                  {!row.purgedAt && (
                    <Popconfirm
                      title={t('users.forceLogoutConfirm')}
                      okText={t('common.confirm')}
                      cancelText={t('common.cancel')}
                      onConfirm={() => void forceLogout(row)}
                    >
                      <Button size="small" type="link" disabled={busy}>
                        {t('users.forceLogout')}
                      </Button>
                    </Popconfirm>
                  )}
                  {!row.purgedAt && (
                    <Button size="small" type="link" disabled={busy} onClick={() => void resetPassword(row)}>
                      {t('users.resetPassword')}
                    </Button>
                  )}
                </Space>
              )
            },
          },
        ]}
      />

      <Modal
        open={Boolean(disableTarget)}
        title={t('users.disableTitle')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmLoading={busy}
        onOk={() => {
          const target = disableTarget
          if (!target) return
          void run(
            () => adminApi.disableUser(target.id, disableReason.trim() || undefined),
            t('users.disabled'),
          ).then(() => setDisableTarget(null))
        }}
        onCancel={() => setDisableTarget(null)}
      >
        <Typography.Paragraph>{t('users.disableHint', { email: disableTarget?.email ?? '' })}</Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={200}
          value={disableReason}
          placeholder={t('users.disableReason')}
          onChange={(event) => setDisableReason(event.target.value)}
        />
      </Modal>

      <Modal
        open={Boolean(resetResult)}
        title={t('users.resetTitle')}
        onCancel={() => setResetResult(null)}
        footer={
          <Button type="primary" onClick={() => setResetResult(null)}>
            {t('common.close')}
          </Button>
        }
      >
        <Alert type="warning" showIcon title={t('users.resetWarning')} style={{ marginBottom: 12 }} />
        <Typography.Paragraph type="secondary">
          {t('users.resetHint', { email: resetResult?.email ?? '' })}
        </Typography.Paragraph>
        <Typography.Paragraph
          code
          copyable={{ icon: <CopyOutlined />, text: resetResult?.url }}
          style={{ wordBreak: 'break-all' }}
        >
          {resetResult?.url}
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary">
          {t('users.resetExpires', {
            time: resetResult ? formatDateTime(resetResult.expiresAt, i18n.language) : '',
          })}
        </Typography.Paragraph>
      </Modal>
    </Card>
  )
}
