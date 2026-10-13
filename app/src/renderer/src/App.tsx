import { useEffect, useState } from 'react'

export default function App() {
  const [version, setVersion] = useState('读取中…')

  useEffect(() => {
    void window.huAgent.getVersion().then(setVersion)
  }, [])

  return (
    <main className="shell">
      <h1>hu-agent</h1>
      <p>客户端骨架已就绪（Electron + React + TypeScript）。</p>
      <p className="muted">应用版本：{version}</p>
      <p className="muted">阶段 0-05 验收：类型化 IPC（app:get-version）已打通。</p>
    </main>
  )
}
