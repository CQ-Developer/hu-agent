import { ConfigProvider } from 'antd'
import enUS from 'antd/locale/en_US'
import zhCN from 'antd/locale/zh_CN'
import { useTranslation } from 'react-i18next'
import { RouterProvider, createBrowserRouter, Navigate } from 'react-router-dom'

import AdminLayout from './layout/AdminLayout'
import Dashboard from './pages/Dashboard'
import NotFound from './pages/NotFound'

const router = createBrowserRouter([
  {
    path: '/',
    element: <AdminLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <Dashboard /> },
      { path: '*', element: <NotFound /> },
    ],
  },
])

export default function App() {
  const { i18n } = useTranslation()
  const locale = i18n.language === 'en-US' ? enUS : zhCN

  return (
    <ConfigProvider locale={locale}>
      <RouterProvider router={router} />
    </ConfigProvider>
  )
}
