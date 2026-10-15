import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { useTranslation } from 'react-i18next'
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from 'react-router-dom'

import { ScopeProvider } from './app/ScopeProvider'
import { useTheme } from './app/theme'
import RequireAuth, { NoPermission } from './auth/RequireAuth'
import { SessionProvider, useSession } from './auth/SessionProvider'
import AdminLayout from './layout/AdminLayout'
import Approvals from './pages/Approvals'
import Audit from './pages/Audit'
import Dashboard from './pages/Dashboard'
import IdentityProviders from './pages/IdentityProviders'
import Login from './pages/Login'
import McpServers from './pages/McpServers'
import Notifications from './pages/Notifications'
import Organizations from './pages/Organizations'
import Settings from './pages/Settings'
import SsoCallback from './pages/SsoCallback'
import Stats from './pages/Stats'
import Members from './pages/Members'
import NotFound from './pages/NotFound'
import Profile from './pages/Profile'
import ResetPassword from './pages/ResetPassword'
import Skills from './pages/Skills'
import Users from './pages/Users'

function SkillsRoute() {
  const { profile } = useSession()
  const location = useLocation()
  void location
  // 服务端仍强制鉴权；这里只做展示控制
  return profile ? <Skills /> : <NoPermission />
}

function McpServersRoute() {
  const { profile } = useSession()
  const location = useLocation()
  void location
  return profile ? <McpServers /> : <NoPermission />
}

function UsersRoute() {
  const { profile } = useSession()
  const location = useLocation()
  void location
  // 服务端仍强制鉴权；这里只做展示控制
  return profile?.isSystemAdmin ? <Users /> : <NoPermission />
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
  { path: '/reset-password', element: <ResetPassword /> },
  { path: '/sso/callback', element: <SsoCallback /> },
  {
    path: '/',
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: 'approvals', element: <Approvals /> },
      { path: 'stats', element: <Stats /> },
      { path: 'organizations', element: <Organizations /> },
      { path: 'notifications', element: <Notifications /> },
      { path: 'audit', element: <Audit /> },
      { path: 'settings', element: <Settings /> },
      { path: 'users', element: <UsersRoute /> },
      { path: 'skills', element: <SkillsRoute /> },
      { path: 'mcp-servers', element: <McpServersRoute /> },
      { path: 'members', element: <Members /> },
      { path: 'identity-providers', element: <IdentityProviders /> },
      { path: 'profile', element: <Profile /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

/** 已登录后的外壳：注入组织/团队上下文（需要 profile 判断权限） */
function AppShell() {
  const { profile } = useSession()
  return (
    <ScopeProvider isSystemAdmin={Boolean(profile?.isSystemAdmin)}>
      <AdminLayout />
    </ScopeProvider>
  )
}

export default function App() {
  const { i18n } = useTranslation()
  const { resolved } = useTheme()
  const locale = i18n.language === 'en-US' ? enUS : zhCN
  const dark = resolved === 'dark'

  return (
    <ConfigProvider
      locale={locale}
      theme={{
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: {
          colorPrimary: dark ? '#7e9aff' : '#5563e8',
          colorInfo: dark ? '#7e9aff' : '#5563e8',
          borderRadius: 12,
          borderRadiusLG: 18,
          colorBgLayout: 'transparent',
          fontFamily:
            "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
        },
        components: {
          Layout: {
            headerBg: 'transparent',
            siderBg: 'transparent',
            bodyBg: 'transparent',
            triggerBg: 'transparent',
          },
          Menu: { itemBg: 'transparent', subMenuItemBg: 'transparent' },
          Table: { headerBg: 'transparent' },
        },
      }}
    >
      {/* antd App：为 message/notification/modal 提供上下文（React 19 下静态方法不可用） */}
      <AntApp>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </AntApp>
    </ConfigProvider>
  )
}
