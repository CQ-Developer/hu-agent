/**
 * MCP 管理页（design 7.2 / 6.5）：团队 MCP server 列表 + 详情抽屉 + 上下架/停用/撤回/删除。
 * 与 Skill 管理页同构；MCP 资源是「连接描述」（配置模板 + env_schema），没有包与下载量，
 * 版本号是递增整数。页壳/状态色/原因弹窗与 Skill 管理页共用（components/resource_admin）。
 */

import { DeleteOutlined } from '@ant-design/icons'
import { App as AntApp, Button, Descriptions, Drawer, Popconfirm, Space, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { mcpApi, type McpEnvField, type McpServer, type McpServerDetail, type McpVersion } from '../api/endpoints'
import ReasonModal from '../components/resource_admin/ReasonModal'
import ResourceAdminCard from '../components/resource_admin/ResourceAdminCard'
import { RESOURCE_STATUS_COLOR } from '../components/resource_admin/statusColors'
import { useAdminTeam } from '../components/resource_admin/useAdminTeam'
import { useAsync } from '../lib/useAsync'
import { formatDateTime } from '../lib/format'
import { errorText } from '../lib/errorText'

export default function McpServers() {
  const { message } = AntApp.useApp()
  const { t, i18n } = useTranslation()
  const { teamId, setTeamId, teams } = useAdminTeam()
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<McpServerDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [action, setAction] = useState<'disable' | 'revoke' | null>(null)
  const [revokeVersion, setRevokeVersion] = useState<number | null>(null)
  const [disableTarget, setDisableTarget] = useState<McpServer | null>(null)
  const [busy, setBusy] = useState(false)

  const list = useAsync(
    () => (teamId ? mcpApi.listTeam(teamId, { status, q: query }) : Promise.resolve({ items: [], total: 0 })),
    [teamId, status, query],
  )

  const openDetail = async (serverId: string): Promise<void> => {
    setDetailLoading(true)
    try {
      setDetail(await mcpApi.detail(serverId))
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
      if (detail) setDetail(await mcpApi.detail(detail.id))
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
      setAction(null)
      setRevokeVersion(null)
      setDisableTarget(null)
    }
  }

  const serverActions = (row: McpServer) => (
    <Space size={4} wrap>
      <Button size="small" type="link" onClick={() => void openDetail(row.id)}>
        {t('common.detail')}
      </Button>
      {row.status !== 'published' && row.status !== 'deleted' && (
        <Button
          size="small"
          type="link"
          onClick={() => void runAction(() => mcpApi.publish(row.id), t('mcp.published'))}
        >
          {t('mcp.publish')}
        </Button>
      )}
      {row.status === 'published' && (
        <>
          <Button size="small" type="link" onClick={() => void runAction(() => mcpApi.delist(row.id), t('mcp.delisted'))}>
            {t('mcp.delist')}
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
            {t('mcp.disable')}
          </Button>
        </>
      )}
      {row.status === 'disabled' && (
        <Button size="small" type="link" onClick={() => void runAction(() => mcpApi.enable(row.id), t('mcp.enabled'))}>
          {t('mcp.enable')}
        </Button>
      )}
      <Popconfirm
        title={t('mcp.deleteConfirm')}
        description={t('mcp.deleteHint')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        onConfirm={() => void runAction(() => mcpApi.remove(row.id), t('mcp.deleted'))}
      >
        <Button size="small" type="link" danger icon={<DeleteOutlined />}>
          {t('common.delete')}
        </Button>
      </Popconfirm>
    </Space>
  )

  const versionColumns = [
    { title: t('mcp.version'), dataIndex: 'version', render: (value: number) => `v${value}` },
    {
      title: t('common.status'),
      dataIndex: 'status',
      render: (value: string) => (
        <Tag color={RESOURCE_STATUS_COLOR[value] ?? 'default'}>{t(`status.${value}`, value)}</Tag>
      ),
    },
    { title: t('mcp.transport'), dataIndex: 'transport' },
    { title: t('mcp.changelog'), dataIndex: 'changelog', render: (value: string | null) => value || '-' },
    {
      title: t('common.createdAt'),
      dataIndex: 'createdAt',
      render: (value: string) => formatDateTime(value, i18n.language),
    },
    {
      title: t('common.actions'),
      render: (_: unknown, row: McpVersion) =>
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
            {t('mcp.revoke')}
          </Button>
        ) : (
          '-'
        ),
    },
  ]

  const envColumns = [
    { title: t('mcp.envKey'), dataIndex: 'key' },
    { title: t('mcp.envLabel'), dataIndex: 'label' },
    {
      title: t('mcp.envSecret'),
      dataIndex: 'secret',
      render: (value: boolean) => (value ? <Tag color="red">{t('mcp.envSecret')}</Tag> : '-'),
    },
    {
      title: t('mcp.envRequired'),
      dataIndex: 'required',
      render: (value: boolean) => (value ? <Tag color="gold">{t('mcp.envRequired')}</Tag> : '-'),
    },
    { title: t('mcp.envHelp'), dataIndex: 'help', render: (value: string | null) => value || '-' },
  ]

  return (
    <>
      <ResourceAdminCard
        title={t('menu.mcp')}
        total={list.data?.total ?? 0}
        loading={list.loading}
        onRefresh={() => void list.reload()}
        emptyTeamsNotice={t('mcp.noAdminTeam')}
        teams={teams}
        teamId={teamId}
        onTeamChange={setTeamId}
        status={status}
        onStatusChange={setStatus}
        query={query}
        onQueryChange={setQuery}
        searchPlaceholder={t('mcp.searchPlaceholder')}
        error={list.error ?? undefined}
      >
        <Table<McpServer>
          size="small"
          rowKey="id"
          loading={list.loading}
          dataSource={list.data?.items ?? []}
          pagination={false}
          columns={[
            { title: t('mcp.name'), dataIndex: 'name' },
            {
              title: t('common.status'),
              dataIndex: 'status',
              render: (value: string) => (
                <Tag color={RESOURCE_STATUS_COLOR[value] ?? 'default'}>{t(`status.${value}`, value)}</Tag>
              ),
            },
            {
              title: t('mcp.latestVersion'),
              dataIndex: 'latestVersion',
              render: (value: number | null) => (value === null ? '-' : `v${value}`),
            },
            {
              title: t('mcp.updatedAt'),
              dataIndex: 'updatedAt',
              render: (value: string) => formatDateTime(value, i18n.language),
            },
            { title: t('common.actions'), render: (_, row) => serverActions(row) },
          ]}
        />
      </ResourceAdminCard>

      <Drawer
        size={720}
        open={Boolean(detail)}
        loading={detailLoading}
        title={detail ? `${detail.name} · ${detail.latestVersion === null ? '-' : `v${detail.latestVersion}`}` : ''}
        onClose={() => setDetail(null)}
      >
        {detail && (
          <>
            <Descriptions column={2} size="small" bordered>
              <Descriptions.Item label={t('common.status')}>
                <Tag color={RESOURCE_STATUS_COLOR[detail.status] ?? 'default'}>
                  {t(`status.${detail.status}`, detail.status)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label={t('mcp.revision')}>{detail.statusRevision}</Descriptions.Item>
              <Descriptions.Item label={t('mcp.updatedAt')}>
                {formatDateTime(detail.updatedAt, i18n.language)}
              </Descriptions.Item>
              <Descriptions.Item label={t('mcp.tags')}>
                {(detail.tags ?? []).map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </Descriptions.Item>
              {detail.disabledReason && (
                <Descriptions.Item label={t('mcp.disabledReason')} span={2}>
                  {detail.disabledReason}
                </Descriptions.Item>
              )}
              <Descriptions.Item label={t('mcp.description')} span={2}>
                {detail.description || '-'}
              </Descriptions.Item>
            </Descriptions>

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('mcp.versions')}
            </Typography.Title>
            <Table<McpVersion>
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={detail.versions}
              columns={versionColumns}
            />

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('mcp.configTemplate')}
            </Typography.Title>
            <pre style={{ background: '#fafafa', padding: 12, borderRadius: 6, fontSize: 12, maxHeight: 200, overflow: 'auto' }}>
              {JSON.stringify(detail.configTemplate ?? {}, null, 2)}
            </pre>

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('mcp.envSchema')}
            </Typography.Title>
            <Table<McpEnvField>
              size="small"
              rowKey="key"
              pagination={false}
              dataSource={detail.envSchema}
              columns={envColumns}
            />

            <Typography.Title level={5} style={{ marginTop: 16 }}>
              {t('mcp.docs')}
            </Typography.Title>
            <pre style={{ background: '#fafafa', padding: 12, borderRadius: 6, fontSize: 12, maxHeight: 260, overflow: 'auto' }}>
              {detail.docsMd}
            </pre>
          </>
        )}
      </Drawer>

      <ReasonModal
        open={action === 'disable'}
        title={t('mcp.disable')}
        hint={t('mcp.disableHint')}
        placeholder={t('mcp.reasonPlaceholder')}
        requiredMessage={t('mcp.reasonRequired')}
        busy={busy}
        onCancel={() => setAction(null)}
        onConfirm={(reason) => {
          if (!disableTarget) return
          void runAction(() => mcpApi.disable(disableTarget.id, reason), t('mcp.disabled'))
        }}
      />

      <ReasonModal
        open={action === 'revoke'}
        title={`${t('mcp.revoke')} ${revokeVersion === null ? '' : `v${revokeVersion}`}`}
        hint={t('mcp.revokeHint')}
        placeholder={t('mcp.reasonPlaceholder')}
        requiredMessage={t('mcp.reasonRequired')}
        busy={busy}
        onCancel={() => setAction(null)}
        onConfirm={(reason) => {
          if (!detail || revokeVersion === null) return
          void runAction(() => mcpApi.revokeVersion(detail.id, revokeVersion, reason), t('mcp.revoked'))
        }}
      />
    </>
  )
}
