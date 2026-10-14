/**
 * 审计日志页（design 7.2 系统区，系统管理员）：按动作/目标/时间筛选，可展开查看详情 JSON。
 */

import { ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Input, Select, Space, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { adminApi, type AuditEntry } from '../api/endpoints'
import { useAsync } from '../lib/useAsync'
import { formatDateTime } from '../lib/format'

const ACTION_PREFIXES = ['', 'auth.', 'account.', 'admin.', 'approval.', 'org.', 'team.', 'skill.', 'sync.', 'resource.']

export default function Audit() {
  const { t, i18n } = useTranslation()
  const [action, setAction] = useState('')
  const [actorId, setActorId] = useState('')
  const [targetType, setTargetType] = useState('')

  const audit = useAsync(
    () => adminApi.audit({ action, actorId: actorId || undefined, targetType: targetType || undefined, limit: 100 }),
    [action, actorId, targetType],
  )

  return (
    <Card
      title={t('menu.audit')}
      extra={
        <Space>
          <Tag>{`${t('common.total')}: ${audit.data?.total ?? 0}`}</Tag>
          <Button icon={<ReloadOutlined />} loading={audit.loading} onClick={() => void audit.reload()}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Select
          size="small"
          style={{ width: 160 }}
          value={action}
          onChange={setAction}
          options={ACTION_PREFIXES.map((value) => ({
            value,
            label: value === '' ? t('audit.allActions') : value,
          }))}
        />
        <Input
          size="small"
          style={{ width: 300 }}
          placeholder={t('audit.actorPlaceholder')}
          value={actorId}
          onChange={(event) => setActorId(event.target.value)}
          allowClear
        />
        <Input
          size="small"
          style={{ width: 180 }}
          placeholder={t('audit.targetPlaceholder')}
          value={targetType}
          onChange={(event) => setTargetType(event.target.value)}
          allowClear
        />
      </Space>

      {audit.error && <Alert type="error" showIcon message={audit.error} style={{ marginBottom: 12 }} />}

      <Table<AuditEntry>
        size="small"
        rowKey="id"
        loading={audit.loading}
        dataSource={audit.data?.items ?? []}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        expandable={{
          expandedRowRender: (row) => (
            <pre style={{ margin: 0, fontSize: 12, background: '#fafafa', padding: 8, borderRadius: 6 }}>
              {JSON.stringify(row.detail, null, 2)}
            </pre>
          ),
        }}
        columns={[
          { title: t('audit.time'), dataIndex: 'createdAt', render: (value: string) => formatDateTime(value, i18n.language) },
          { title: t('audit.action'), dataIndex: 'action', render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
          {
            title: t('audit.actor'),
            dataIndex: 'actorId',
            render: (value: string | null) => (value ? <Typography.Text code>{value.slice(0, 8)}</Typography.Text> : '-'),
          },
          { title: t('audit.target'), dataIndex: 'targetType', render: (value: string | null) => value ?? '-' },
          { title: t('audit.targetId'), dataIndex: 'targetId', render: (value: string | null) => value ?? '-' },
        ]}
      />
    </Card>
  )
}
