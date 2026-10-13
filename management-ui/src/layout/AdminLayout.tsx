import { GlobalOutlined } from '@ant-design/icons'
import { Layout, Menu, Segmented, Typography } from 'antd'
import { useTranslation } from 'react-i18next'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'

const { Header, Sider, Content } = Layout

export default function AdminLayout() {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider theme="dark" breakpoint="lg" collapsedWidth={64}>
        <div style={{ color: '#fff', padding: 16, fontWeight: 600 }}>hu-agent</div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          onClick={({ key }) => void navigate(key)}
          items={[{ key: '/dashboard', label: t('menu.dashboard') }]}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingInline: 24,
          }}
        >
          <Typography.Text strong>{t('app.name')}</Typography.Text>
          <Segmented
            size="small"
            value={i18n.language}
            onChange={(value) => void i18n.changeLanguage(String(value))}
            options={[
              { label: '中文', value: 'zh-CN' },
              { label: 'EN', value: 'en-US' },
            ]}
            prefix={<GlobalOutlined />}
          />
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
