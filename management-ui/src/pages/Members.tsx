/**
 * 成员与邀请（design 7.2）：组织成员 / 团队成员 + 角色变更 + 移除 + 一次性邀请码。
 * 最后管理员保护由服务端强制（这里只把错误原样提示）。
 */

import { CopyOutlined, ReloadOutlined, UserAddOutlined } from '@ant-design/icons'
import { App as AntApp, Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { orgApi, teamApi, type OrgMember, type TeamMember } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useSession } from '../auth/SessionProvider'
import { useAsync } from '../lib/useAsync'
import { formatDateTime } from '../lib/format'
import { errorText } from '../lib/errorText'

type MemberRow = OrgMember | TeamMember

export default function Members() {
  const { message } = AntApp.useApp()
  const { t, i18n } = useTranslation()
  const scope = useScope()
  const { profile } = useSession()
  const [tab, setTab] = useState<'team' | 'org'>(scope.adminTeams.length ? 'team' : 'org')
  const [teamId, setTeamId] = useState<string | undefined>(scope.team?.id ?? scope.adminTeams[0]?.id)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member')
  const [inviteToken, setInviteToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const members = useAsync(
    () =>
      tab === 'team'
        ? teamId
          ? teamApi.members(teamId)
          : Promise.resolve({ items: [], total: 0 })
        : scope.org
          ? orgApi.members(scope.org.id)
          : Promise.resolve({ items: [], total: 0 }),
    [tab, teamId, scope.org?.id],
  )

  const currentTeamId = teamId ?? scope.team?.id ?? scope.adminTeams[0]?.id

  const changeRole = async (row: MemberRow, role: 'admin' | 'member'): Promise<void> => {
    try {
      if (tab === 'team' && currentTeamId) await teamApi.setMemberRole(currentTeamId, row.userId, role)
      else if (scope.org) await orgApi.setMemberRole(scope.org.id, row.userId, role)
      void message.success(t('members.roleUpdated'))
      await members.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    }
  }

  const removeMember = async (row: MemberRow): Promise<void> => {
    try {
      if (tab === 'team' && currentTeamId) await teamApi.removeMember(currentTeamId, row.userId)
      else if (scope.org) await orgApi.removeMember(scope.org.id, row.userId)
      void message.success(t('members.removed'))
      await members.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    }
  }

  const submitInvite = async (): Promise<void> => {
    setBusy(true)
    try {
      const created =
        tab === 'team' && currentTeamId
          ? await teamApi.invite(currentTeamId, inviteEmail.trim(), inviteRole)
          : scope.org
            ? await orgApi.invite(scope.org.id, inviteEmail.trim(), inviteRole)
            : null
      setInviteToken(created?.acceptToken ?? null)
      void message.success(t('members.inviteCreated'))
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const columns = [
    { title: t('members.email'), dataIndex: 'email' },
    { title: t('members.displayName'), dataIndex: 'displayName' },
    {
      title: t('members.role'),
      dataIndex: 'role',
      render: (value: string, row: MemberRow) => (
        <Select<'admin' | 'member'>
          size="small"
          value={value as 'admin' | 'member'}
          style={{ width: 120 }}
          disabled={row.userId === profile?.id}
          onChange={(next) => void changeRole(row, next)}
          options={[
            { value: 'admin', label: t('members.admin') },
            { value: 'member', label: t('members.member') },
          ]}
        />
      ),
    },
    {
      title: t('common.status'),
      dataIndex: 'status',
      render: (value: string | undefined) => (value ? <Tag>{t(`status.${value}`, value)}</Tag> : '-'),
    },
    {
      title: t('members.joinedAt'),
      dataIndex: 'joinedAt',
      render: (value: string) => formatDateTime(value, i18n.language),
    },
    {
      title: t('common.actions'),
      render: (_: unknown, row: MemberRow) => (
        <Popconfirm
          title={t('members.removeConfirm')}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
          disabled={row.userId === profile?.id}
          onConfirm={() => void removeMember(row)}
        >
          <Button size="small" type="link" danger disabled={row.userId === profile?.id}>
            {t('members.remove')}
          </Button>
        </Popconfirm>
      ),
    },
  ]

  const noRights = scope.adminTeams.length === 0 && !scope.canManageOrg

  return (
    <Card
      title={t('menu.members')}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} loading={members.loading} onClick={() => void members.reload()}>
            {t('common.refresh')}
          </Button>
          <Button
            type="primary"
            icon={<UserAddOutlined />}
            disabled={noRights}
            onClick={() => {
              setInviteToken(null)
              setInviteEmail('')
              setInviteRole('member')
              setInviteOpen(true)
            }}
          >
            {t('members.invite')}
          </Button>
        </Space>
      }
    >
      {noRights ? (
        <Alert type="info" showIcon message={t('members.noRights')} />
      ) : (
        <>
          <Tabs
            activeKey={tab}
            onChange={(key) => setTab(key as 'team' | 'org')}
            items={[
              ...(scope.adminTeams.length
                ? [
                    {
                      key: 'team',
                      label: t('members.tabTeam'),
                      children: (
                        <>
                          <Space style={{ marginBottom: 12 }}>
                            <Select
                              style={{ minWidth: 200 }}
                              value={currentTeamId}
                              onChange={(value: string) => setTeamId(value)}
                              options={scope.adminTeams.map((team) => ({ value: team.id, label: team.name }))}
                            />
                          </Space>
                          <Table<TeamMember>
                            size="small"
                            rowKey="userId"
                            loading={members.loading}
                            dataSource={(members.data?.items ?? []) as TeamMember[]}
                            pagination={false}
                            columns={columns}
                          />
                        </>
                      ),
                    },
                  ]
                : []),
              ...(scope.canManageOrg
                ? [
                    {
                      key: 'org',
                      label: t('members.tabOrg'),
                      children: (
                        <Table<OrgMember>
                          size="small"
                          rowKey="userId"
                          loading={members.loading}
                          dataSource={(members.data?.items ?? []) as OrgMember[]}
                          pagination={false}
                          columns={columns}
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {members.error && <Alert type="error" showIcon message={members.error} style={{ marginTop: 12 }} />}
        </>
      )}

      <Modal
        open={inviteOpen}
        title={t('members.invite')}
        okText={t('common.confirm')}
        cancelText={t('common.close')}
        confirmLoading={busy}
        onOk={() => (inviteToken ? setInviteOpen(false) : void submitInvite())}
        onCancel={() => setInviteOpen(false)}
      >
        {inviteToken ? (
          <>
            <Alert type="success" showIcon message={t('members.inviteCreated')} style={{ marginBottom: 12 }} />
            <Typography.Paragraph type="secondary">{t('members.inviteTokenHint')}</Typography.Paragraph>
            <Typography.Paragraph code copyable={{ icon: <CopyOutlined /> }} style={{ wordBreak: 'break-all' }}>
              {inviteToken}
            </Typography.Paragraph>
            <Typography.Paragraph type="warning">{t('members.inviteOnceWarning')}</Typography.Paragraph>
          </>
        ) : (
          <Form layout="vertical">
            <Form.Item label={t('members.email')} required>
              <Input value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="user@example.com" />
            </Form.Item>
            <Form.Item label={t('members.role')}>
              <Select
                value={inviteRole}
                onChange={(value: 'admin' | 'member') => setInviteRole(value)}
                options={[
                  { value: 'member', label: t('members.member') },
                  { value: 'admin', label: t('members.admin') },
                ]}
              />
            </Form.Item>
            <Typography.Paragraph type="secondary">{t('members.inviteHint')}</Typography.Paragraph>
          </Form>
        )}
      </Modal>
    </Card>
  )
}
