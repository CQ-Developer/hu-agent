/**
 * 资源管理页外壳（Skill / MCP 共用，design 7.2）：
 * 卡片头（总数 + 刷新）+ 团队/状态/搜索筛选 + 错误提示 + 表格插槽。
 * 详情抽屉与操作弹窗由各页面自行追加。
 */

import { ReloadOutlined, SearchOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Input, Select, Space, Tag } from 'antd'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

export interface ResourceAdminCardProps {
  title: string
  total: number
  loading: boolean
  onRefresh: () => void
  /** 当前账号不是任何团队管理员时的提示 */
  emptyTeamsNotice: string
  teams: { id: string; name: string }[]
  teamId?: string
  onTeamChange: (id: string) => void
  status: string
  onStatusChange: (status: string) => void
  query: string
  onQueryChange: (query: string) => void
  searchPlaceholder: string
  error?: string
  children: ReactNode
}

export default function ResourceAdminCard(props: ResourceAdminCardProps) {
  const { t } = useTranslation()

  return (
    <Card
      title={props.title}
      extra={
        <Space>
          <Tag>{`${t('common.total')}: ${props.total}`}</Tag>
          <Button icon={<ReloadOutlined />} loading={props.loading} onClick={props.onRefresh}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      {props.teams.length === 0 ? (
        <Alert type="info" showIcon title={props.emptyTeamsNotice} />
      ) : (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            <Select
              style={{ minWidth: 200 }}
              value={props.teamId}
              onChange={props.onTeamChange}
              options={props.teams.map((team) => ({ value: team.id, label: team.name }))}
            />
            <Select
              style={{ minWidth: 140 }}
              value={props.status}
              onChange={props.onStatusChange}
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
              placeholder={props.searchPlaceholder}
              value={props.query}
              onChange={(event) => props.onQueryChange(event.target.value)}
            />
          </Space>
          {props.error && <Alert type="error" showIcon title={props.error} style={{ marginBottom: 12 }} />}
          {props.children}
        </>
      )}
    </Card>
  )
}
