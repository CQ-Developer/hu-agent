/**
 * 概览页（design 7.2）：服务端状态 + 与当前账号相关的数字 + 常用入口。
 */

import { Alert, Card, Col, Descriptions, Row, Space, Statistic, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

import { approvalApi, meApi, systemApi } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useSession } from '../auth/SessionProvider'
import { errorText } from '../lib/errorText'

interface HealthState {
  status: string
  time: string
}

export default function Dashboard() {
  const { t } = useTranslation()
  const { profile } = useSession()
  const scope = useScope()
  const [health, setHealth] = useState<HealthState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<number | null>(null)
  const [unread, setUnread] = useState<number | null>(null)

  useEffect(() => {
    void systemApi
      .health()
      .then(setHealth)
      .catch((cause: unknown) => setError(errorText(cause, t)))
  }, [])

  useEffect(() => {
    void approvalApi
      .list({ scope: 'mine', status: 'pending', limit: 1 })
      .then((result) => setPending(result.total))
      .catch(() => setPending(null))
    void meApi
      .notifications()
      .then((result) => setUnread(result.unread))
      .catch(() => setUnread(null))
  }, [])

  return (
    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={6}>
          <Card>
            <Statistic title={t('dashboard.myOrgs')} value={scope.orgs.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title={t('dashboard.myTeams')} value={scope.teams.length} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title={t('dashboard.pendingApprovals')} value={pending ?? '-'} />
          </Card>
        </Col>
        <Col span={6}>
          <Card>
            <Statistic title={t('dashboard.unreadNotifications')} value={unread ?? '-'} />
          </Card>
        </Col>
      </Row>

      <Card title={t('dashboard.title')}>
        {error ? (
          <Alert type="error" showIcon title={t('dashboard.apiError')} description={error} />
        ) : (
          <Descriptions column={1} size="small">
            <Descriptions.Item label={t('dashboard.apiStatus')}>
              {health ? <Tag color="green">{health.status}</Tag> : t('common.loading')}
            </Descriptions.Item>
            <Descriptions.Item label={t('dashboard.serverTime')}>{health?.time ?? '-'}</Descriptions.Item>
            <Descriptions.Item label={t('common.systemAdmin')}>
              {profile?.isSystemAdmin ? <Tag color="gold">yes</Tag> : <Tag>no</Tag>}
            </Descriptions.Item>
          </Descriptions>
        )}
      </Card>

      <Card title={t('dashboard.quickLinks')}>
        <Space orientation="vertical">
          <Link to="/approvals">{t('menu.approvals')}</Link>
          {scope.adminTeams.length > 0 && <Link to="/skills">{t('menu.skills')}</Link>}
          {(scope.canManageOrg || scope.adminTeams.length > 0) && <Link to="/members">{t('menu.members')}</Link>}
          {profile?.isSystemAdmin && <Link to="/identity-providers">{t('menu.identityProviders')}</Link>}
        </Space>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
          {t('dashboard.stageHint')}
        </Typography.Paragraph>
      </Card>
    </Space>
  )
}
