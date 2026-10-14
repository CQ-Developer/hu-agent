/**
 * 组织与团队治理页（design 7.2）：
 *  - 组织管理员：改名称/描述、查看本组织团队、改名/冻结团队、申请创建团队
 *  - 系统管理员：冻结/解冻/解散组织（解散为软删：团队归档、资源删除，个人工作空间不受影响）
 */

import { EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, App as AntApp, Button, Card, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { governanceApi, type Team } from '../api/endpoints'
import { adminApi } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useAsync } from '../lib/useAsync'
import { errorText } from '../lib/errorText'

const STATUS_COLOR: Record<string, string> = { active: 'green', frozen: 'orange', deleted: 'default', archived: 'orange' }

export default function Organizations() {
  const { t } = useTranslation()
  const { message } = AntApp.useApp()
  const scope = useScope()
  const [orgId, setOrgId] = useState<string | undefined>(scope.org?.id)
  const [editOpen, setEditOpen] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [editForm] = Form.useForm<{ name: string; description: string }>()
  const [applyForm] = Form.useForm<{ name: string; description: string; reason: string }>()

  const org = scope.orgs.find((item) => item.id === orgId) ?? null
  const teams = useAsync(
    () => (orgId ? governanceApi.orgTeams(orgId) : Promise.resolve({ items: [], total: 0 })),
    [orgId],
  )

  useEffect(() => {
    if (!orgId && scope.orgs.length) setOrgId(scope.orgs[0].id)
  }, [orgId, scope.orgs])

  const canGovern = Boolean(scope.isSystemAdmin)
  const canEdit = Boolean(org && (org.role === 'admin' || scope.isSystemAdmin))

  const run = async (task: () => Promise<unknown>, successText: string): Promise<void> => {
    setBusy(true)
    try {
      await task()
      message.success(successText)
      await Promise.all([scope.reload(), teams.reload()])
    } catch (cause) {
      message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title={t('menu.organizations')}
      extra={
        <Space>
          <Select
            style={{ minWidth: 200 }}
            value={orgId}
            onChange={setOrgId}
            options={scope.orgs.map((item) => ({ value: item.id, label: item.name }))}
          />
          <Button icon={<ReloadOutlined />} loading={teams.loading} onClick={() => void teams.reload()}>
            {t('common.refresh')}
          </Button>
          <Button icon={<PlusOutlined />} onClick={() => setApplyOpen(true)} disabled={!scope.isSystemAdmin && scope.orgs.length === 0}>
            {t('organizations.applyTeam')}
          </Button>
        </Space>
      }
    >
      {!org && <Alert type="info" showIcon message={t('organizations.noOrg')} />}

      {org && (
        <>
          <Descriptions
            size="small"
            bordered
            column={2}
            style={{ marginBottom: 16 }}
            extra={
              canEdit ? (
                <Space>
                  <Button
                    size="small"
                    icon={<EditOutlined />}
                    onClick={() => {
                      editForm.setFieldsValue({ name: org.name, description: org.description })
                      setEditOpen(true)
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                  {canGovern && (org.status === 'active' ? (
                    <Button
                      size="small"
                      danger
                      onClick={() => void run(() => adminApi.freezeOrg(org.id), t('organizations.frozen'))}
                    >
                      {t('organizations.freeze')}
                    </Button>
                  ) : org.status === 'frozen' ? (
                    <Button
                      size="small"
                      onClick={() => void run(() => adminApi.unfreezeOrg(org.id), t('organizations.unfrozen'))}
                    >
                      {t('organizations.unfreeze')}
                    </Button>
                  ) : null)}
                  {canGovern && org.status !== 'deleted' && (
                    <Popconfirm
                      title={t('organizations.dissolveConfirm')}
                      description={t('organizations.dissolveHint')}
                      okText={t('common.confirm')}
                      cancelText={t('common.cancel')}
                      onConfirm={() => void run(() => adminApi.dissolveOrg(org.id), t('organizations.dissolved'))}
                    >
                      <Button size="small" danger>
                        {t('organizations.dissolve')}
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ) : null
            }
          >
            <Descriptions.Item label={t('organizations.name')}>{org.name}</Descriptions.Item>
            <Descriptions.Item label={t('common.status')}>
              <Tag color={STATUS_COLOR[org.status] ?? 'default'}>{t(`status.${org.status}`, org.status)}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label={t('organizations.slug')}>{org.slug}</Descriptions.Item>
            <Descriptions.Item label={t('organizations.role')}>{org.role ? t(`members.${org.role}`) : '-'}</Descriptions.Item>
            <Descriptions.Item label={t('organizations.members')}>{org.memberCount ?? 0}</Descriptions.Item>
            <Descriptions.Item label={t('organizations.teams')}>{org.teamCount ?? 0}</Descriptions.Item>
            <Descriptions.Item label={t('organizations.description')} span={2}>
              {org.description || '-'}
            </Descriptions.Item>
          </Descriptions>

          <Table<Team>
            size="small"
            rowKey="id"
            loading={teams.loading}
            dataSource={teams.data?.items ?? []}
            pagination={false}
            columns={[
              { title: t('organizations.teamName'), dataIndex: 'name' },
              {
                title: t('common.status'),
                dataIndex: 'status',
                render: (value: string) => <Tag color={STATUS_COLOR[value] ?? 'default'}>{t(`status.${value}`, value)}</Tag>,
              },
              { title: t('organizations.members'), dataIndex: 'memberCount' },
              { title: t('organizations.myRole'), dataIndex: 'myRole', render: (value: string | null) => (value ? t(`members.${value}`) : '-') },
              {
                title: t('common.actions'),
                render: (_: unknown, row: Team) => (
                  <Space size={6}>
                    <InlineTeamEdit team={row} onSaved={() => void teams.reload()} />
                    {canGovern && (
                      <Switch
                        size="small"
                        checked={row.status === 'active'}
                        checkedChildren={t('organizations.active')}
                        unCheckedChildren={t('organizations.archived')}
                        onChange={(checked) =>
                          void run(
                            () => governanceApi.patchTeam(row.id, { status: checked ? 'active' : 'archived' }),
                            checked ? t('organizations.teamRestored') : t('organizations.teamArchived'),
                          )
                        }
                      />
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </>
      )}

      <Modal
        open={editOpen}
        title={t('organizations.editOrg')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={busy}
        onCancel={() => setEditOpen(false)}
        onOk={() => {
          void editForm.validateFields().then((values) =>
            run(() => governanceApi.patchOrg(org!.id, values), t('settings.saved')).then(() => setEditOpen(false)),
          )
        }}
      >
        <Form form={editForm} layout="vertical">
          <Form.Item name="name" label={t('organizations.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('organizations.description')}>
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={applyOpen}
        title={t('organizations.applyTeam')}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
        confirmLoading={busy}
        onCancel={() => setApplyOpen(false)}
        onOk={() => {
          void applyForm.validateFields().then(async (values) => {
            if (!orgId) return
            setBusy(true)
            try {
              await governanceApi.applyTeam(orgId, values.name, values.description, values.reason)
              message.success(t('organizations.applySubmitted'))
              setApplyOpen(false)
              applyForm.resetFields()
            } catch (cause) {
              message.error(errorText(cause, t))
            } finally {
              setBusy(false)
            }
          })
        }}
      >
        <Alert type="info" showIcon message={t('organizations.applyHint')} style={{ marginBottom: 12 }} />
        <Form form={applyForm} layout="vertical">
          <Form.Item name="name" label={t('organizations.teamName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('organizations.description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="reason" label={t('organizations.reason')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}

/** 团队行内改名的轻量弹窗（仅组织管理员/系统管理员可见的编辑入口） */
function InlineTeamEdit({ team, onSaved }: { team: Team; onSaved: () => void }) {
  const { t } = useTranslation()
  const { message } = AntApp.useApp()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<{ name: string; description: string }>()

  return (
    <>
      <Button
        size="small"
        type="link"
        onClick={() => {
          form.setFieldsValue({ name: team.name, description: team.description })
          setOpen(true)
        }}
      >
        {t('common.edit')}
      </Button>
      <Modal
        open={open}
        title={t('organizations.editTeam')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={busy}
        onCancel={() => setOpen(false)}
        onOk={() => {
          void form.validateFields().then(async (values) => {
            setBusy(true)
            try {
              await governanceApi.patchTeam(team.id, values)
              message.success(t('settings.saved'))
              setOpen(false)
              onSaved()
            } catch (cause) {
              message.error(errorText(cause, t))
            } finally {
              setBusy(false)
            }
          })
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('organizations.teamName')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label={t('organizations.description')}>
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
