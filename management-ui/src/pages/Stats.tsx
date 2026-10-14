/**
 * 统计页（design 7.2）：范围/日期/维度筛选 + 总量卡片 + 按日柱状图 + 明细表 + CSV 导出。
 * 范围按权限收敛（个人 / 本团队 / 本组织 / 全系统），服务端仍会强制校验。
 */

import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { Alert, Button, Card, Col, Row, Select, Space, Statistic, Table, Tag } from 'antd'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { statsApi, type Usage } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useAsync } from '../lib/useAsync'
import { downloadCsv } from '../lib/csv'
import { daysAgoISO, formatNumber, todayISO } from '../lib/format'
type StatsScope = 'self' | 'team' | 'org' | 'global'
type GroupBy = 'day' | 'model' | 'member' | 'team' | 'org'

export default function Stats() {
  const { t, i18n } = useTranslation()
  const scope = useScope()
  const [statsScope, setStatsScope] = useState<StatsScope>(scope.canManageTeam ? 'team' : scope.canManageOrg ? 'org' : 'self')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')
  const [from, setFrom] = useState(daysAgoISO(29))
  const [to, setTo] = useState(todayISO())

  const scopeOptions = useMemo(() => {
    const options: { value: StatsScope; label: string }[] = [{ value: 'self', label: t('stats.scopeSelf') }]
    if (scope.adminTeams.length > 0) options.push({ value: 'team', label: t('stats.scopeTeam') })
    if (scope.canManageOrg) options.push({ value: 'org', label: t('stats.scopeOrg') })
    if (scope.isSystemAdmin) options.push({ value: 'global', label: t('stats.scopeGlobal') })
    return options
  }, [t, scope.adminTeams.length, scope.canManageOrg, scope.isSystemAdmin])

  const groupOptions: GroupBy[] =
    statsScope === 'global'
      ? ['day', 'model', 'org']
      : statsScope === 'org'
        ? ['day', 'model', 'team']
        : statsScope === 'team'
          ? ['day', 'model', 'member']
          : ['day', 'model']

  const usage = useAsync<Usage>(
    () =>
      statsApi.usage({
        scope: statsScope,
        from,
        to,
        groupBy: groupBy,
        teamId: statsScope === 'team' ? scope.adminTeams[0]?.id : scope.team?.id,
        orgId: statsScope === 'org' ? scope.org?.id : undefined,
      }),
    [statsScope, groupBy, from, to, scope.team?.id, scope.org?.id, scope.adminTeams],
  )

  const rows = usage.data?.rows ?? []
  const maxTokens = useMemo(
    () => rows.reduce((max, row) => Math.max(max, (row.inputTokens ?? 0) + (row.outputTokens ?? 0)), 0),
    [rows],
  )

  const columns = [
    ...(groupBy === 'day' ? [{ title: t('stats.day'), dataIndex: 'day' }] : []),
    ...(groupBy === 'model'
      ? [
          { title: t('stats.provider'), dataIndex: 'provider' },
          { title: t('stats.model'), dataIndex: 'model' },
        ]
      : []),
    ...(groupBy === 'member' ? [{ title: t('stats.member'), dataIndex: 'userId' }] : []),
    ...(groupBy === 'team' ? [{ title: t('stats.team'), dataIndex: 'teamId' }] : []),
    ...(groupBy === 'org' ? [{ title: t('stats.org'), dataIndex: 'orgId' }] : []),
    { title: t('stats.inputTokens'), dataIndex: 'inputTokens', render: (value: number) => formatNumber(value, i18n.language) },
    { title: t('stats.outputTokens'), dataIndex: 'outputTokens', render: (value: number) => formatNumber(value, i18n.language) },
    { title: t('stats.requests'), dataIndex: 'requests', render: (value: number) => formatNumber(value, i18n.language) },
    { title: t('stats.errors'), dataIndex: 'errors', render: (value: number) => formatNumber(value, i18n.language) },
    {
      title: t('stats.estimatedCost'),
      dataIndex: 'estimatedCost',
      render: (value: number | undefined) => (value === undefined ? '-' : `${value.toFixed(4)} ${usage.data?.currency ?? 'USD'}`),
    },
  ]

  const exportCsv = (): void => {
    const headers = columns.map((column) => String(column.title))
    const data = rows.map((row) =>
      columns.map((column) => {
        const key = (column as { dataIndex?: string }).dataIndex
        return key ? ((row as unknown as Record<string, string | number>)[key] ?? '') : ''
      }),
    )
    downloadCsv(`hu-agent-usage-${from}-${to}.csv`, headers, data)
  }

  return (
    <Card
      title={t('menu.stats')}
      extra={
        <Space>
          <Button icon={<DownloadOutlined />} onClick={exportCsv} disabled={rows.length === 0}>
            {t('stats.exportCsv')}
          </Button>
          <Button icon={<ReloadOutlined />} loading={usage.loading} onClick={() => void usage.reload()}>
            {t('common.refresh')}
          </Button>
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 12 }}>
        <Space.Compact>
          {scopeOptions.map((option) => (
            <Button
              key={option.value}
              size="small"
              type={statsScope === option.value ? 'primary' : 'default'}
              onClick={() => {
                setStatsScope(option.value)
                if (!groupOptionsFor(option.value).includes(groupBy)) setGroupBy('day')
              }}
            >
              {option.label}
            </Button>
          ))}
        </Space.Compact>
        <Select<GroupBy>
          size="small"
          style={{ width: 140 }}
          value={groupBy}
          onChange={setGroupBy}
          options={groupOptions.map((value) => ({ value, label: t(`stats.group.${value}`) }))}
        />
        <input
          type="date"
          className="hg-date-input"
          value={from}
          max={to}
          onChange={(event) => setFrom(event.target.value)}
        />
        <span style={{ color: '#999' }}>—</span>
        <input
          type="date"
          className="hg-date-input"
          value={to}
          min={from}
          max={todayISO()}
          onChange={(event) => setTo(event.target.value)}
        />
        {statsScope === 'team' && scope.team && <Tag>{scope.team.name}</Tag>}
        {statsScope === 'org' && scope.org && <Tag>{scope.org.name}</Tag>}
      </Space>

      {usage.error && <Alert type="error" showIcon title={usage.error} style={{ marginBottom: 12 }} />}

      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={4}>
          <Statistic title={t('stats.inputTokens')} value={usage.data?.totals.inputTokens ?? 0} />
        </Col>
        <Col span={4}>
          <Statistic title={t('stats.outputTokens')} value={usage.data?.totals.outputTokens ?? 0} />
        </Col>
        <Col span={4}>
          <Statistic title={t('stats.cacheReadTokens')} value={usage.data?.totals.cacheReadTokens ?? 0} />
        </Col>
        <Col span={4}>
          <Statistic title={t('stats.requests')} value={usage.data?.totals.requests ?? 0} />
        </Col>
        <Col span={4}>
          <Statistic title={t('stats.errors')} value={usage.data?.totals.errors ?? 0} />
        </Col>
        <Col span={4}>
          <Statistic
            title={t('stats.estimatedCost')}
            value={usage.data?.totals.estimatedCost ?? 0}
            precision={4}
            suffix={usage.data?.currency ?? 'USD'}
          />
        </Col>
      </Row>

      {groupBy === 'day' && rows.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120, marginBottom: 16 }}>
          {rows.map((row) => {
            const total = (row.inputTokens ?? 0) + (row.outputTokens ?? 0)
            const height = maxTokens ? Math.max(2, Math.round((total / maxTokens) * 110)) : 2
            return (
              <div
                key={row.day}
                title={`${row.day}: ${total}`}
                style={{ flex: 1, height, background: '#1677ff', borderRadius: 2, opacity: 0.85 }}
              />
            )
          })}
        </div>
      )}

      <Table
        size="small"
        rowKey={(row) => `${row.day ?? ''}-${row.provider ?? ''}-${row.model ?? ''}-${row.userId ?? ''}-${row.teamId ?? ''}-${row.orgId ?? ''}`}
        loading={usage.loading}
        dataSource={rows}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={columns}
      />
    </Card>
  )
}

function groupOptionsFor(scope: StatsScope): GroupBy[] {
  if (scope === 'global') return ['day', 'model', 'org']
  if (scope === 'org') return ['day', 'model', 'team']
  if (scope === 'team') return ['day', 'model', 'member']
  return ['day', 'model']
}
