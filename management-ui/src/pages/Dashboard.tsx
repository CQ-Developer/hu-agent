import { Alert, Card, Descriptions, Space, Tag } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getHealth } from '../api/client'

interface HealthState {
  status: string
  time: string
}

export default function Dashboard() {
  const { t } = useTranslation()
  const [health, setHealth] = useState<HealthState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [])

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Card title={t('dashboard.title')}>
        {error ? (
          <Alert type="error" showIcon message={t('dashboard.apiError')} description={error} />
        ) : (
          <Descriptions column={1} size="small">
            <Descriptions.Item label={t('dashboard.apiStatus')}>
              {health ? <Tag color="green">{health.status}</Tag> : t('dashboard.loading')}
            </Descriptions.Item>
            <Descriptions.Item label={t('dashboard.serverTime')}>{health?.time ?? '-'}</Descriptions.Item>
          </Descriptions>
        )}
      </Card>
      <Alert type="info" showIcon message={t('dashboard.stageHint')} />
    </Space>
  )
}
