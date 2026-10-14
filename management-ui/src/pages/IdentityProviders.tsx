/**
 * 身份源（SSO）管理页（design 6.12 / 7.2，系统管理员）：
 * client_secret 只写不读（服务端仅返回 hasSecret）；禁用/删除会立即撤销该身份源的会话。
 */

import { PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { App as AntApp, Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { identityApi, type IdentityProvider } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useAsync } from '../lib/useAsync'
import { formatDateTime } from '../lib/format'
import { errorText } from '../lib/errorText'

interface FormValues {
  name: string
  issuerUrl: string
  clientId: string
  clientSecret?: string
  scopes?: string
  allowedEmailDomains?: string[]
  autoJoinOrgId?: string | null
  allowAutoLink?: boolean
}

export default function IdentityProviders() {
  const { message } = AntApp.useApp()
  const { t, i18n } = useTranslation()
  const scope = useScope()
  const [editing, setEditing] = useState<IdentityProvider | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form] = Form.useForm<FormValues>()

  const providers = useAsync(() => identityApi.list(), [])

  const openCreate = (): void => {
    setEditing(null)
    form.setFieldsValue({ scopes: 'openid profile email', allowAutoLink: true, allowedEmailDomains: [] })
    setOpen(true)
  }

  const openEdit = (provider: IdentityProvider): void => {
    setEditing(provider)
    form.setFieldsValue({
      name: provider.name,
      issuerUrl: provider.issuerUrl,
      clientId: provider.clientId,
      clientSecret: '',
      scopes: provider.scopes,
      allowedEmailDomains: provider.allowedEmailDomains,
      autoJoinOrgId: provider.autoJoinOrgId ?? undefined,
      allowAutoLink: provider.allowAutoLink,
    })
    setOpen(true)
  }

  const submit = async (): Promise<void> => {
    const values = await form.validateFields()
    setBusy(true)
    try {
      // 留空表示保持原密钥（服务端只写不读）
      const payload = { ...values, clientSecret: values.clientSecret ? values.clientSecret : undefined }
      if (editing) await identityApi.update(editing.id, payload)
      else await identityApi.create(payload)
      void message.success(t('identity.saved'))
      setOpen(false)
      await providers.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (provider: IdentityProvider, enabled: boolean): Promise<void> => {
    try {
      await identityApi.update(provider.id, { enabled })
      void message.success(enabled ? t('identity.enabled') : t('identity.disabled'))
      await providers.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    }
  }

  const remove = async (provider: IdentityProvider): Promise<void> => {
    try {
      await identityApi.remove(provider.id)
      void message.success(t('identity.removed'))
      await providers.reload()
    } catch (cause) {
      void message.error(errorText(cause, t))
    }
  }

  return (
    <Card
      title={t('menu.identityProviders')}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} loading={providers.loading} onClick={() => void providers.reload()}>
            {t('common.refresh')}
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            {t('identity.create')}
          </Button>
        </Space>
      }
    >
      <Alert type="info" showIcon message={t('identity.hint')} style={{ marginBottom: 12 }} />
      {providers.error && <Alert type="error" showIcon message={providers.error} style={{ marginBottom: 12 }} />}
      <Table<IdentityProvider>
        size="small"
        rowKey="id"
        loading={providers.loading}
        dataSource={providers.data ?? []}
        pagination={false}
        columns={[
          { title: t('identity.name'), dataIndex: 'name' },
          { title: t('identity.issuerUrl'), dataIndex: 'issuerUrl', render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
          { title: t('identity.clientId'), dataIndex: 'clientId' },
          {
            title: t('identity.enabled'),
            dataIndex: 'enabled',
            render: (value: boolean, row) => (
              <Switch size="small" checked={value} onChange={(next) => void toggle(row, next)} />
            ),
          },
          {
            title: t('identity.secret'),
            dataIndex: 'hasSecret',
            render: (value: boolean) => <Tag color={value ? 'green' : 'default'}>{value ? t('identity.secretSet') : t('identity.secretMissing')}</Tag>,
          },
          {
            title: t('identity.autoJoin'),
            dataIndex: 'autoJoinOrgId',
            render: (value: string | null) => scope.orgs.find((org) => org.id === value)?.name ?? '-',
          },
          {
            title: t('identity.updatedAt'),
            dataIndex: 'updatedAt',
            render: (value: string) => formatDateTime(value, i18n.language),
          },
          {
            title: t('common.actions'),
            render: (_: unknown, row) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => openEdit(row)}>
                  {t('common.edit')}
                </Button>
                <Popconfirm
                  title={t('identity.removeConfirm')}
                  description={t('identity.removeHint')}
                  okText={t('common.confirm')}
                  cancelText={t('common.cancel')}
                  onConfirm={() => void remove(row)}
                >
                  <Button size="small" type="link" danger>
                    {t('common.delete')}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        open={open}
        title={editing ? t('identity.edit') : t('identity.create')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={busy}
        onOk={() => void submit()}
        onCancel={() => setOpen(false)}
        width={560}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="name" label={t('identity.name')} rules={[{ required: true }]}>
            <Input placeholder="Keycloak" />
          </Form.Item>
          <Form.Item
            name="issuerUrl"
            label={t('identity.issuerUrl')}
            rules={[{ required: true }]}
            extra={t('identity.issuerHint')}
          >
            <Input placeholder="https://idp.example.com/realms/huagent" />
          </Form.Item>
          <Form.Item name="clientId" label={t('identity.clientId')} rules={[{ required: true }]}>
            <Input placeholder="hu-agent" />
          </Form.Item>
          <Form.Item
            name="clientSecret"
            label={t('identity.clientSecret')}
            extra={editing ? t('identity.secretKeepHint') : t('identity.secretHint')}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="scopes" label={t('identity.scopes')}>
            <Input placeholder="openid profile email" />
          </Form.Item>
          <Form.Item name="allowedEmailDomains" label={t('identity.allowedDomains')} extra={t('identity.allowedDomainsHint')}>
            <Select mode="tags" tokenSeparators={[',', ' ']} placeholder="example.com" />
          </Form.Item>
          <Form.Item name="autoJoinOrgId" label={t('identity.autoJoin')} extra={t('identity.autoJoinHint')}>
            <Select
              allowClear
              placeholder={t('common.none')}
              options={scope.orgs.map((org) => ({ value: org.id, label: org.name }))}
            />
          </Form.Item>
          <Form.Item name="allowAutoLink" label={t('identity.allowAutoLink')} valuePropName="checked" extra={t('identity.allowAutoLinkHint')}>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
