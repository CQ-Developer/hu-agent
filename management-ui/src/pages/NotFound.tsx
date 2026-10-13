import { Button, Result } from 'antd'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

export default function NotFound() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  return (
    <Result
      status="404"
      title="404"
      subTitle={t('notFound.subTitle')}
      extra={
        <Button type="primary" onClick={() => void navigate('/dashboard')}>
          {t('notFound.back')}
        </Button>
      }
    />
  )
}
