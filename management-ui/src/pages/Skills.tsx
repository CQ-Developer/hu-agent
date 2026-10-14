/**
 * Skill 管理页（design 7.2 / 6.4.3）：团队资源列表 + 审核抽屉 + 上下架/停用/撤回/删除。
 * 高风险操作（停用、撤回、删除）一律要求填写原因并与服务端一致地二次确认。
 */

import { DeleteOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { App as AntApp, Alert, Button, Card, Descriptions, Drawer, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { skillApi, type Skill, type SkillDetail, type SkillVersion } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useAsync } from '../lib/useAsync'
import { formatBytes, formatDateTime } from '../lib/format'
import { errorText } from '../lib/errorText'

const STATUS_COLOR: Record<string, string> = {
  draft: 'default',
  pending: 'processing',
  published: 'success',
  rejected: 'error',
  superseded: 'default',
  delisted: 'warning',
  disabled: 'error',
  deleted: 'default',
  revoked: 'error',
}

export default function Skills() {
  const { message } = AntApp.useApp()
  const { t, i18n } = useTranslation()
  const scope = useScope()
  const [teamId, setTeamId] = useState<string | undefined>(scope.team?.id)
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [reason, setReason] = useState('')
  const [action, setAction] = useState<'disable' | 'revoke' | null>(null)
  const [revokeVersion, setRevokeVersion] = useState<string | null>(null)
  const [disableTarget, setDisableTarget] = useState<Skill | null>(null)
  const [busy, setBusy] = useState(false)

  // 默认跟随顶部团队选择（若我是其管理员）；否则回退到第一个可管理团队
  useEffect(() => {
    const selected = scope.team?.id
    if (selected && scope.adminTeams.some((team) => team.id === selected)) {
      setTeamId((current) => (current === selected ? current : selected))
      return
    }
    if (!teamId && scope.adminTeams.length) setTeamId(scope.adminTeams[0].id)
  }, [scope.team?.id, scope.adminTeams, teamId])

  const list = useAsync(
    () => (teamId ? skillApi.listTeam(teamId, { status, q: query }) : Promise.resolve({ items: [], total: 0 })),
    [teamId, status, query],
  )

  const teams = useMemo(() => scope.adminTeams, [scope.adminTeams])

  const openDetail = async (skillId: string): Promise<void> => {
    setDetailLoading(true)
    try {
      setDetail(await skillApi.detail(skillId))
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setDetailLoading(false)
    }
  }

  const runAction = async (task: () => Promise<unknown>, successText: string): Promise<void> => {
    setBusy(true)
    try {
      await task()
      void message.success(successText)
      await list.reload()
      if (detail) setDetail(await skillApi.detail(detail.id))
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
      setAction(null)
      setReason('')
      setRevokeVersion(null)
      setDisableTarget(null)
    }
  }

  const skillActions = (row: Skill) => (
    <Space size={4} wrap>
      <Button size="small" type="link" onClick={() => void openDetail(row.id)}>
        {t('common.detail')}
      </Button>
      {row.status !== 'published' && row.status !== 'deleted' && (
        <Button
          size="small"
          type="link"
          onClick={() => void runAction(() => skillApi.publish(row.id), t('skills.published'))}
        >
          {t('skills.publish')}
        </Button>
      )}
      {row.status === 'published' && (
        <>
          <Button size="small" type="link" onClick={() => void runAction(() => skillApi.delist(row.id), t('skills.delisted'))}>
            {t('skills.delist')}
          </Button>
          <Button
            size="small"
            type="link"
            danger
            onClick={() => {
              setDisableTarget(row)
              setAction('disable')
            }}
          >
            {t('skills.disable')}
          </Button>
        </>
      )}
      {row.status === 'disabled' && (
        <Button size="small" type="link" onClick={() => void runAction(() => skillApi.enable(row.id), t('skills.enabled'))}>
          {t('skills.enable')}
        </Button>
      )}
      <Popconfirm
        title={t('skills.deleteConfirm')}
        description={t('skills.deleteHint')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={() => void runAction(() => skillApi.remove(row.id), t('skills.deleted'))}
      >
        <Button size="small" type="link" danger icon={<DeleteOutlined />}>
          {t('common.delete')}
        </Button>
      </Popconfirm>
    </Space>
  )

  const versionColumns = [
    { title: t('skills.version'), dataIndex: 'version' },
    {
      title: t('common.status'),
      dataIndex: 'status',
      render: (value: string) => <Tag color={STATUS_COLOR[value] ?? 'default'}>{t(`status.${value}`, value)}</Tag>,
    },
    { title: t('skills.size'), dataIndex: 'sizeBytes', render: (value: number) => formatBytes(value) },
    { title: t('skills.downloads'), dataIndex: 'downloadCount' },
    {
      title: t('common.createdAt'),
      dataIndex: 'createdAt',
      render: (value: string) => formatDateTime(value, i18n.language),
    },
    {
      title: t('common.actions'),
      render: (_: unknown, row: SkillVersion) =>
        row.status === 'published' ? (
          <Button
            size="small"
            type="link"
            danger
            onClick={() => {
              setRevokeVersion(row.version)
              setAction('revoke')
            }}
          >
            {t('skills.revoke')}
          </Button>
        ) : (
          '-'
        ),
    },
  ]

  return (
    <Card
      title={t('menu.skills')}
      extra={
        <Space>
          <Tag>{`${t('common.total')}: ${list.data?.total ?? 0}`}</Tag>
          <Button icon={<ReloadOutlined />} loading={list.loading} onClick={() => void list.reload()}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      {teams.length === 0 ? (
        <Alert type="info" showIcon message={t('skills.noAdminTeam')} />
      ) : (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            <Select
              style={{ minWidth: 200 }}
              value={teamId}
              onChange={setTeamId}
              options={teams.map((team) => ({ value: team.id, label: team.name }))}
            />
            <Select
              style={{ minWidth: 140 }}
              value={status}
              onChange={setStatus}
              options={[
                { value: '', label: t('common.all') },
                { value: 'published', label: t('status.published') },
                { value: 'draft', label: t('status.draft') },
                { value: 'delisted', label: t('status.delisted') },
                { value: 'disabled', label: t('status.disabled') },
              ]}
            />
            <Input
              allowClear
              style={{ width: 240 }}
              prefix={<SearchOutlined />}
              placeholder={t('skills.searchPlaceholder')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </Space>
          {list.error && <Alert type="error" showIcon message={list.error} style={{ marginBottom: 12 }} />}
          <Table<Skill>
            size="small"
            rowKey="id"
            loading={list.loading}
            dataSource={list.data?.items ?? []}
            pagination={false}
            columns={[
              { title: t('skills.name'), dataIndex: 'name' },
              {
                title: t('common.status'),
                dataIndex: 'status',
                render: (value: string) => <Tag color={STATUS_COLOR[value] ?? 'default'}>{t(`status.${value}`, value)}</Tag>,
              },
              { title: t('skills.latestVersion'), dataIndex: 'latestVersion', render: (value: string | null) => value ?? '-' },
              { title: t('skills.downloads'), dataIndex: 'downloadCount' },
              {
                title: t('skills.updatedAt'),
                dataIndex: 'updatedAt',
                render: (value: string) => formatDateTime(value, i18n.language),
              },
              { title: t('common.actions'), render: (_, row) => skillActions(row) },
            ]}
          />
        </>
      )}

      <Drawer
        width={680}
        open={Boolean(detail)}
        loading={detailLoading}
        title={detail ? `${detail.name} · ${detail.latestVersion ?? '-'}` : ''}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label={t('common.status')}>
                <Tag color={STATUS_COLOR[detail.status] ?? 'default'}>{t(`status.${detail.status}`, detail.status)}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('skills.revision')}>{detail.statusRevision}</Descriptions.Item>
              <Descriptions.Item label={t('skills.downloads')}>{detail.downloadCount}</Descriptions.Item>
              <Descriptions.Item label={t('skills.updatedAt')}>
                {formatDateTime(detail.updatedAt, i18n.language)}
              </Descriptions.Item>
              <Descriptions.Item label={t('skills.tags')} span={2}>
                {(detail.tags ?? []).map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </Descriptions.Item>
              {detail.disabledReason && (
                <Descriptions.Item label={t('skills.disabledReason')} span={2}>
                  {detail.disabledReason}
                </Descriptions.Item>
              )}
              <Descriptions.Item label={t('skills.description')} span={2}>
                {detail.description || '-'}
              </Descriptions.Item>
            </Descriptions>

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('skills.versions')}
            </Typography.Title>
            <Table<SkillVersion>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={detail.versions}
              columns={versionColumns}
            />

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('skills.skillMd')}
            </Typography.Title>
            <pre style={{ background: '#fafafa', padding: 12, borderRadius: 6, fontSize: 12, maxHeight: 260, overflow: 'auto' }}>
              {detail.skillMd}
            </pre>
          </>
        )}
      </Drawer>

      <Modal
        open={action === 'disable'}
        title={t('skills.disable')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true, loading: busy }}
        onCancel={() => setAction(null)}
        onOk={() => {
          if (!reason.trim()) {
            void message.warning(t('skills.reasonRequired'))
            return
          }
          if (!disableTarget) return
          void runAction(() => skillApi.disable(disableTarget.id, reason), t('skills.disabled'))
        }}
      >
        <Alert type="warning" showIcon message={t('skills.disableHint')} style={{ marginBottom: 12 }} />
        <Input.TextArea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('skills.reasonPlaceholder')} />
      </Modal>

      <Modal
        open={action === 'revoke'}
        title={`${t('skills.revoke')} ${revokeVersion ?? ''}`}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        okButtonProps={{ danger: true, loading: busy }}
        onCancel={() => setAction(null)}
        onOk={() => {
          if (!reason.trim()) {
            void message.warning(t('skills.reasonRequired'))
            return
          }
          if (!detail || !revokeVersion) return
          void runAction(() => skillApi.revokeVersion(detail.id, revokeVersion, reason), t('skills.revoked'))
        }}
      >
        <Alert type="warning" showIcon message={t('skills.revokeHint')} style={{ marginBottom: 12 }} />
        <Input.TextArea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('skills.reasonPlaceholder')} />
      </Modal>
    </Card>
  )
}
