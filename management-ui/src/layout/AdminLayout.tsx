/**
 * 管理台布局（design 7.1）：左侧按角色动态菜单 + 顶部组织/团队切换、待办审批、账号菜单。
 */

import {
  ApiOutlined,
  ApartmentOutlined,
  BellOutlined,
  AuditOutlined,
  BarChartOutlined,
  BellOutlined as BellIcon,
  CheckSquareOutlined,
  DashboardOutlined,
  GlobalOutlined,
  LogoutOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { Avatar, Badge, Button, Dropdown, Empty, Layout, Menu, Popover, Segmented, Select, Space, Tag, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

import { meApi } from '../api/endpoints'
import { useScope } from '../app/ScopeProvider'
import { useSession } from '../auth/SessionProvider'
import i18n from '../i18n'
import { useAsync } from '../lib/useAsync'
import { formatDateTime } from '../lib/format'

const { Header, Sider, Content } = Layout

export default function AdminLayout() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { profile, logout, patchProfile } = useSession()
  const scope = useScope()
  const [bellOpen, setBellOpen] = useState(false)

  const notifications = useAsync(() => meApi.notifications(), [bellOpen])
  const unread = notifications.data?.unread ?? 0

  const items = useMemo(() => {
    const entries = [
      { key: '/dashboard', icon: <DashboardOutlined />, label: t('menu.dashboard') },
      { key: '/approvals', icon: <CheckSquareOutlined />, label: t('menu.approvals') },
      { key: '/stats', icon: <BarChartOutlined />, label: t('menu.stats') },
    ]
    if (scope.adminTeams.length > 0) {
      entries.push({ key: '/skills', icon: <SafetyCertificateOutlined />, label: t('menu.skills') })
      entries.push({ key: '/mcp-servers', icon: <ApiOutlined />, label: t('menu.mcp') })
    }
    if (scope.canManageOrg || scope.adminTeams.length > 0) {
      entries.push({ key: '/members', icon: <TeamOutlined />, label: t('menu.members') })
    }
    if (scope.canManageOrg || scope.isSystemAdmin) {
      entries.push({ key: '/organizations', icon: <ApartmentOutlined />, label: t('menu.organizations') })
    }
    entries.push({ key: '/notifications', icon: <BellIcon />, label: t('menu.notifications') })
    if (scope.isSystemAdmin) {
      entries.push({ key: '/identity-providers', icon: <GlobalOutlined />, label: t('menu.identityProviders') })
      entries.push({ key: '/users', icon: <UserOutlined />, label: t('menu.users') })
      entries.push({ key: '/audit', icon: <AuditOutlined />, label: t('menu.audit') })
      entries.push({ key: '/settings', icon: <SettingOutlined />, label: t('menu.settings') })
    }
    return entries
  }, [t, scope.adminTeams.length, scope.canManageOrg, scope.isSystemAdmin])

  const bellContent = (
    <div style={{ width: 360, maxHeight: 420, overflow: 'auto' }}>
      {notifications.data?.items.length ? (
        <>
          <div style={{ textAlign: 'right', marginBottom: 8 }}>
            <Button
              size="small"
              type="link"
              onClick={() => {
                void meApi.markNotifications(true).then(() => notifications.reload())
              }}
            >
              {t('notifications.markAllRead')}
            </Button>
          </div>
          {notifications.data.items.map((note) => (
            <div key={note.id} style={{ padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
              <Space size={6}>
                {!note.readAt && <Badge status="processing" />}
                <Typography.Text strong>{note.title}</Typography.Text>
              </Space>
              <div style={{ color: '#666', fontSize: 12 }}>{note.body}</div>
              <div style={{ color: '#999', fontSize: 12 }}>{formatDateTime(note.createdAt, i18n.language)}</div>
            </div>
          ))}
        </>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('notifications.empty')} />
      )}
    </div>
  )

  const accountMenu = {
    items: [
      { key: 'profile', icon: <UserOutlined />, label: t('menu.profile') },
      { key: 'logout', icon: <LogoutOutlined />, label: t('menu.logout') },
    ],
    onClick: ({ key }: { key: string }) => {
      if (key === 'logout') void logout()
      else navigate('/profile')
    },
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" breakpoint="lg" collapsedWidth={64}>
        <div style={{ color: '#fff', padding: 16, fontWeight: 600 }}>hu-agent</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          onClick={({ key }) => void navigate(key)}
          items={items}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 16,
            gap: 12,
          }}
        >
          <Space size={8}>
            <Typography.Text strong>{t('app.name')}</Typography.Text>
            {scope.isSystemAdmin && <Tag color="gold">{t('common.systemAdmin')}</Tag>}
          </Space>
          <Space size={12}>
            <Select
              size="small"
              style={{ minWidth: 180 }}
              value={scope.team?.id ?? undefined}
              placeholder={t('common.selectTeam')}
              onChange={(value: string) => scope.setTeamId(value)}
              options={scope.teams.map((team) => ({
                value: team.id,
                label: `${team.name}${team.myRole === 'admin' ? ` (${t('common.admin')})` : ''}`,
              }))}
            />
            <Popover
              content={bellContent}
              title={t('notifications.title')}
              trigger="click"
              open={bellOpen}
              onOpenChange={setBellOpen}
            >
              <Badge count={unread} size="small">
                <Button type="text" icon={<BellOutlined />} />
              </Badge>
            </Popover>
            <Segmented
              size="small"
              value={i18n.language}
              onChange={(value) => {
                const next = String(value) as 'zh-CN' | 'en-US'
                void i18n.changeLanguage(next)
                // 语言偏好写入用户设置（design 7.1）
                void patchProfile({ locale: next }).catch(() => undefined)
              }}
              options={[
                { label: '中文', value: 'zh-CN' },
                { label: 'EN', value: 'en-US' },
              ]}
            />
            <Dropdown menu={accountMenu} placement="bottomRight">
              <Space style={{ cursor: 'pointer' }}>
                <Avatar size="small" icon={<UserOutlined />} />
                <span>{profile?.displayName || profile?.email}</span>
              </Space>
            </Dropdown>
          </Space>
        </Header>
        <Content style={{ padding: 16 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
