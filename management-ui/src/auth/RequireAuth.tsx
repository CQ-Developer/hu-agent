/** 路由守卫：未登录时跳登录页并记录来源路径（design 7.1）。 */

import { Result, Spin } from 'antd'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation } from 'react-router-dom'

import { useSession } from './SessionProvider'

export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { status } = useSession()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, paddingTop: 160 }}>
        <Spin size="large" />
        <span style={{ color: '#999' }}>{t('common.loading')}</span>
      </div>
    )
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

/** 无权限占位（仅展示控制，服务端仍会拒绝） */
export function NoPermission() {
  const { t } = useTranslation()
  return <Result status="403" title="403" subTitle={t('common.noPermission')} />
}
