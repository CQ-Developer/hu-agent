/**
 * 系统设置页（design 7.2 系统区，系统管理员）：
 *  - 平台设置：白名单键（配额/保留/宽限期/最低客户端版本）
 *  - 价格表：模型单价（每 1K token，按生效日期版本化）
 */

import { DeleteOutlined, PlusOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { Alert, App as AntApp, Button, Card, Form, Input, InputNumber, Popconfirm, Space, Table, Tabs, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { adminApi, type ModelPrice, type SettingItem } from '../api/endpoints'
import { useAsync } from '../lib/useAsync'
import { errorText } from '../lib/errorText'

export default function Settings() {
  const { t } = useTranslation()

  return (
    <Tabs
      items={[
        { key: 'platform', label: t('settings.tabPlatform'), children: <PlatformSettings /> },
        { key: 'prices', label: t('settings.tabPrices'), children: <PriceTable /> },
      ]}
    />
  )
}

function PlatformSettings() {
  const { t } = useTranslation()
  const { message } = AntApp.useApp()
  const [values, setValues] = useState<Record<string, number | string>>({})
  const [busy, setBusy] = useState(false)
  const settings = useAsync(() => adminApi.settings(), [])

  useEffect(() => {
    if (!settings.data) return
    setValues(Object.fromEntries(settings.data.items.map((item) => [item.key, item.value])))
  }, [settings.data])

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await adminApi.updateSettings(values)
      message.success(t('settings.saved'))
      await settings.reload()
    } catch (cause) {
      message.error(errorText(cause, t))
    } finally {
      setBusy(false)
    }
  }

  const items: SettingItem[] = settings.data?.items ?? []

  return (
    <Card
      title={t('settings.platformTitle')}
      extra={
        <Space>
          <Button icon={<ReloadOutlined />} loading={settings.loading} onClick={() => void settings.reload()}>
            {t('common.refresh')}
          </Button>
          <Button type="primary" icon={<SaveOutlined />} loading={busy} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </Space>
      }
    >
      <Alert type="info" showIcon title={t('settings.platformHint')} style={{ marginBottom: 12 }} />
      {settings.error && <Alert type="error" showIcon title={settings.error} style={{ marginBottom: 12 }} />}
      <Form layout="vertical" style={{ maxWidth: 520 }}>
        {items.map((item) => (
          <Form.Item
            key={item.key}
            label={t(`settings.key.${item.key}`, item.key)}
            extra={t(`settings.hint.${item.key}`, '')}
          >
            {item.valueType === 'int' ? (
              <InputNumber
                style={{ width: 220 }}
                min={item.minValue ?? 0}
                value={typeof values[item.key] === 'number' ? (values[item.key] as number) : undefined}
                onChange={(value) => setValues((prev) => ({ ...prev, [item.key]: value ?? 0 }))}
              />
            ) : (
              <Input
                style={{ width: 220 }}
                value={String(values[item.key] ?? '')}
                onChange={(event) => setValues((prev) => ({ ...prev, [item.key]: event.target.value }))}
              />
            )}
          </Form.Item>
        ))}
      </Form>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('settings.updatedAtHint')}
      </Typography.Paragraph>
    </Card>
  )
}

function PriceTable() {
  const { t } = useTranslation()
  const { message } = AntApp.useApp()
  const [form] = Form.useForm<ModelPrice>()
  const prices = useAsync(() => adminApi.prices(), [])

  const submit = async (): Promise<void> => {
    try {
      const values = await form.validateFields()
      await adminApi.upsertPrice(values)
      message.success(t('settings.priceSaved'))
      await prices.reload()
    } catch (cause) {
      message.error(errorText(cause, t))
    }
  }

  const remove = async (row: ModelPrice): Promise<void> => {
    try {
      await adminApi.deletePrice(row.provider, row.model, row.effectiveFrom)
      message.success(t('settings.priceDeleted'))
      await prices.reload()
    } catch (cause) {
      message.error(errorText(cause, t))
    }
  }

  return (
    <Card
      title={t('settings.pricesTitle')}
      extra={
        <Button icon={<ReloadOutlined />} loading={prices.loading} onClick={() => void prices.reload()}>
          {t('common.refresh')}
        </Button>
      }
    >
      <Alert type="info" showIcon title={t('settings.pricesHint')} style={{ marginBottom: 12 }} />
      {prices.error && <Alert type="error" showIcon title={prices.error} style={{ marginBottom: 12 }} />}

      <Form form={form} layout="inline" style={{ marginBottom: 16, rowGap: 8 }}>
        <Form.Item name="provider" label={t('settings.provider')} rules={[{ required: true }]}>
          <Input style={{ width: 130 }} placeholder="deepseek" />
        </Form.Item>
        <Form.Item name="model" label={t('settings.model')} rules={[{ required: true }]}>
          <Input style={{ width: 160 }} placeholder="deepseek-chat" />
        </Form.Item>
        <Form.Item name="currency" label={t('settings.currency')} initialValue="USD">
          <Input style={{ width: 80 }} />
        </Form.Item>
        <Form.Item name="inputPrice" label={t('settings.inputPrice')} initialValue={0}>
          <InputNumber style={{ width: 110 }} min={0} step={0.01} />
        </Form.Item>
        <Form.Item name="outputPrice" label={t('settings.outputPrice')} initialValue={0}>
          <InputNumber style={{ width: 110 }} min={0} step={0.01} />
        </Form.Item>
        <Form.Item name="effectiveFrom" label={t('settings.effectiveFrom')} rules={[{ required: true }]}>
          <Input type="date" style={{ width: 150 }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => void submit()}>
            {t('settings.savePrice')}
          </Button>
        </Form.Item>
      </Form>

      <Table<ModelPrice>
        size="small"
        rowKey={(row) => `${row.provider}/${row.model}/${row.effectiveFrom}`}
        loading={prices.loading}
        dataSource={prices.data ?? []}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: t('settings.provider'), dataIndex: 'provider' },
          { title: t('settings.model'), dataIndex: 'model' },
          { title: t('settings.currency'), dataIndex: 'currency' },
          { title: t('settings.inputPrice'), dataIndex: 'inputPrice' },
          { title: t('settings.outputPrice'), dataIndex: 'outputPrice' },
          { title: t('settings.effectiveFrom'), dataIndex: 'effectiveFrom' },
          {
            title: t('common.actions'),
            render: (_: unknown, row: ModelPrice) => (
              <Popconfirm
                title={t('settings.deletePriceConfirm')}
                okText={t('common.confirm')}
                cancelText={t('common.cancel')}
                onConfirm={() => void remove(row)}
              >
                <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                  {t('common.delete')}
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Card>
  )
}
