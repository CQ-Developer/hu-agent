/**
 * 审批页（design 7.2）：筛选 + 表格 + 抽屉详情 + 通过/驳回。
 * 驳回必须填写意见（服务端同样强制）。
 */

import { CheckOutlined, CloseOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { App as AntApp, Alert, Button, Card, Descriptions, Drawer, Form, Input, Modal, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { approvalApi, type Approval } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useAsync } from '../lib/useAsync'
import { formatDateTime } from '../lib/format'
import { errorText } from '../lib/errorText'

const STATUS_COLOR: Record<string, string> = {
  pending: 'processing',
  approved: 'success',
  rejected: 'error',
  cancelled: 'default',
  stale: 'warning',
}

export default function Approvals() {
  const { message } = AntApp.useApp()
  const { t, i18n } = useTranslation()
  const scope = useScope()
  const [status, setStatus] = useState<string>('pending')
  const [scopeKind, setScopeKind] = useState<'mine' | 'team' | 'org' | 'system'>('mine')
  const [scopeTouched, setScopeTouched] = useState(false)
  const [selected, setSelected] = useState<Approval | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  // 默认落在权限最高的范围（系统管理员→全系统、团队管理员→本团队…），用户手动切换后不再自动改
  useEffect(() => {
    if (scopeTouched || scope.loading) return
    if (scope.isSystemAdmin) setScopeKind('system')
    else if (scope.canManageTeam && scope.adminTeams.length > 0) setScopeKind('team')
    else if (scope.canManageOrg) setScopeKind('org')
  }, [scopeTouched, scope.loading, scope.isSystemAdmin, scope.canManageTeam, scope.canManageOrg, scope.adminTeams.length])

  const scopeOptions = useMemo(() => {
    const options: { value: typeof scopeKind; label: string }[] = [{ value: 'mine', label: t('approvals.scopeMine') }]
    if (scope.canManageTeam) options.push({ value: 'team', label: t('approvals.scopeTeam') })
    if (scope.canManageOrg) options.push({ value: 'org', label: t('approvals.scopeOrg') })
    if (scope.isSystemAdmin) options.push({ value: 'system', label: t('approvals.scopeSystem') })
    return options
  }, [t, scope.canManageTeam, scope.canManageOrg, scope.isSystemAdmin])

  const list = useAsync(
    () =>
      approvalApi.list({
        scope: scopeKind,
        status: status || undefined,
        teamId: scopeKind === 'team' ? scope.team?.id : undefined,
        orgId: scopeKind === 'org' ? scope.org?.id : undefined,
      }),
    [scopeKind, status, scope.team?.id, scope.org?.id],
  )

  const decide = async (approve: boolean): Promise<void> => {
    if (!selected) return
    if (!approve && !comment.trim()) {
      void message.warning(t('approvals.rejectCommentRequired'))
      return
    }
    setBusy(true)
    try {
      if (approve) await approvalApi.approve(selected.id, comment.trim() || undefined)
      else await approvalApi.reject(selected.id, comment.trim())
      void message.success(approve ? t('approvals.approved') : t('approvals.rejected'))
      setSelected(null)
      setComment('')
      setRejecting(false)
      await list.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      await approvalApi.cancel(selected.id)
      void message.success(t('approvals.cancelled'))
      setSelected(null)
      await list.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const canDecide = selected?.status === 'pending' && scopeKind !== 'mine'

  return (
    <Card
      title={t('menu.approvals')}
      extra={
        <Space>
          <Tag>{`${t('common.total')}: ${list.data?.total ?? 0}`}</Tag>
          <Button icon={<ReloadOutlined />} onClick={() => void list.reload()} loading={list.loading}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Form.Item label={t('approvals.scope')} style={{ marginBottom: 0 }}>
          <Space.Compact>
            {scopeOptions.map((option) => (
              <Button
                key={option.value}
                size="small"
                type={scopeKind === option.value ? 'primary' : 'default'}
                onClick={() => {
                  setScopeTouched(true)
                  setScopeKind(option.value)
                }}
              >
                {option.label}
              </Button>
            ))}
          </Space.Compact>
        </Form.Item>
        <Space.Compact>
          {[
            { value: 'pending', label: t('status.pending') },
            { value: 'approved', label: t('status.approved') },
            { value: 'rejected', label: t('status.rejected') },
            { value: '', label: t('common.all') },
          ].map((option) => (
            <Button
              key={option.value || 'all'}
              size="small"
              type={status === option.value ? 'primary' : 'default'}
              onClick={() => setStatus(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </Space.Compact>
      </Space>

      {list.error && <Alert type="error" showIcon title={list.error} style={{ marginBottom: 12 }} />}

      <Table<Approval>
        size="small"
        rowKey="id"
        loading={list.loading}
        dataSource={list.data?.items ?? []}
        pagination={false}
        onRow={(row) => ({ onClick: () => setSelected(row), style: { cursor: 'pointer' } })}
        columns={[
          { title: t('approvals.type'), dataIndex: 'type', render: (value: string) => t(`approvalType.${value}`, value) },
          {
            title: t('approvals.requester'),
            dataIndex: 'requesterId',
            render: (value: string) => <Typography.Text code>{value.slice(0, 8)}</Typography.Text>,
          },
          {
            title: t('approvals.target'),
            render: (_, row) => row.targetType ?? '-',
          },
          {
            title: t('common.status'),
            dataIndex: 'status',
            render: (value: string) => <Tag color={STATUS_COLOR[value] ?? 'default'}>{t(`status.${value}`, value)}</Tag>,
          },
          {
            title: t('common.createdAt'),
            dataIndex: 'createdAt',
            render: (value: string) => formatDateTime(value, i18n.language),
          },
          {
            title: t('common.actions'),
            render: (_, row) => (
              <Button
                size="small"
                type="link"
                onClick={(event) => {
                  event.stopPropagation()
                  setSelected(row)
                }}
              >
                {t('common.detail')}
              </Button>
            ),
          },
        ]}
      />

      <Drawer
        open={Boolean(selected)}
        width={520}
        title={t('approvals.detail')}
        onClose={() => {
          setSelected(null)
          setComment('')
          setRejecting(false)
        }}
        extra={
          canDecide ? (
            <Space>
              <Button
                type="primary"
                icon={<CheckOutlined />}
                loading={busy}
                onClick={() => void decide(true)}
              >
                {t('approvals.approve')}
              </Button>
              <Button danger icon={<CloseOutlined />} loading={busy} onClick={() => setRejecting(true)}>
                {t('approvals.reject')}
              </Button>
            </Space>
          ) : selected?.status === 'pending' && scopeKind === 'mine' ? (
            <Button danger icon={<StopOutlined />} loading={busy} onClick={() => void cancel()}>
              {t('approvals.cancelMine')}
            </Button>
          ) : null
        }
      >
        {selected && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={t('approvals.type')}>
                {t(`approvalType.${selected.type}`, selected.type)}
              </Descriptions.Item>
              <Descriptions.Item label={t('common.status')}>
                <Tag color={STATUS_COLOR[selected.status] ?? 'default'}>{t(`status.${selected.status}`, selected.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('approvals.requester')}>{selected.requesterId}</Descriptions.Item>
              <Descriptions.Item label={t('common.createdAt')}>
                {formatDateTime(selected.createdAt, i18n.language)}
              </Descriptions.Item>
              {selected.decidedAt && (
                <Descriptions.Item label={t('approvals.decidedAt')}>
                  {formatDateTime(selected.decidedAt, i18n.language)}
                </Descriptions.Item>
              )}
              {selected.reviewComment && (
                <Descriptions.Item label={t('approvals.reviewComment')}>{selected.reviewComment}</Descriptions.Item>
              )}
            </Descriptions>

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('approvals.payload')}
            </Typography.Title>
            <pre style={{ background: '#fafafa', padding: 12, borderRadius: 6, fontSize: 12, maxHeight: 260, overflow: 'auto' }}>
              {JSON.stringify(selected.payload, null, 2)}
            </pre>

            {canDecide && (
              <Form layout="vertical" style={{ marginTop: 16 }}>
                <Form.Item label={t('approvals.comment')} help={t('approvals.commentHelp')}>
                  <Input.TextArea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
                </Form.Item>
              </Form>
            )}
          </>
        )}
      </Drawer>

      <Modal
        open={rejecting}
        title={t('approvals.reject')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true, loading: busy }}
        onOk={() => void decide(false)}
        onCancel={() => setRejecting(false)}
      >
        <Form layout="vertical">
          <Form.Item label={t('approvals.comment')} required>
            <Input.TextArea rows={3} value={comment} onChange={(event) => setComment(event.target.value)} />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
