/**
 * 高风险操作的原因填写弹窗（Skill / MCP 共用，design 7.2）：
 * 停用 / 撤回版本都要求填写原因，空值拒绝提交。
 */

import { App as AntApp, Alert, Input, Modal } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export interface ReasonModalProps {
  open: boolean
  title: string
  hint: string
  placeholder: string
  requiredMessage: string
  busy: boolean
  onCancel: () => void
  onConfirm: (reason: string) => void
}

export default function ReasonModal(props: ReasonModalProps) {
  const { t } = useTranslation()
  const { message } = AntApp.useApp()
  const [reason, setReason] = useState('')

  // 关闭后清空，避免下次打开残留上次输入
  useEffect(() => {
    if (!props.open) setReason('')
  }, [props.open])

  return (
    <Modal
      open={props.open}
      title={props.title}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      okButtonProps={{ danger: true, loading: props.busy }}
      onCancel={props.onCancel}
      onOk={() => {
        if (!reason.trim()) {
          void message.warning(props.requiredMessage)
          return
        }
        props.onConfirm(reason)
      }}
    >
      <Alert type="warning" showIcon title={props.hint} style={{ marginBottom: 12 }} />
      <Input.TextArea
        rows={3}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder={props.placeholder}
      />
    </Modal>
  )
}
