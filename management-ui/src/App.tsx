import { App as AntApp, ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { useTranslation } from 'react-i18next'
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from 'react-router-dom'

import { ScopeProvider } from './app/ScopeProvider'
import RequireAuth, { NoPermission } from './auth/RequireAuth'
import { SessionProvider, useSession } from './auth/SessionProvider'
import AdminLayout from './layout/AdminLayout'
import Approvals from './pages/Approvals'
import Dashboard from './pages/Dashboard'
import IdentityProviders from './pages/IdentityProviders'
import Login from './pages/Login'
import Members from './pages/Members'
import NotFound from './pages/NotFound'
import Profile from './pages/Profile'
import Skills from './pages/Skills'

function SkillsRoute() {
  const { profile } = useSession()
  const location = useLocation()
  void location
  // 服务端仍强制鉴权；这里只做展示控制
  return profile ? <Skills /> : <NoPermission />
}

const router = createBrowserRouter([
  { path: '/login', element: <Login /> },
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
      { path: 'skills', element: <SkillsRoute /> },
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
  const locale = i18n.language === 'en-US' ? enUS : zhCN

  return (
    <ConfigProvider locale={locale}>
      {/* antd App：为 message/notification/modal 提供上下文（React 19 下静态方法不可用） */}
      <AntApp>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </AntApp>
    </ConfigProvider>
  )
}
