import { useEffect, useState } from 'react'

export default function AboutSection() {
  const [version, setVersion] = useState('-')
  const [exportMessage, setExportMessage] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    void window.huAgent.getVersion().then(setVersion)
  }, [])

  const exportDiagnostics = async (): Promise<void> => {
    setExporting(true)
    setExportMessage(null)
    try {
      const result = await window.huAgent.diagnostics.export()
      setExportMessage(
        result.canceled ? null : `已导出 ${result.files} 个文件到 ${result.path}（密钥已脱敏）`,
      )
    } catch (cause) {
      setExportMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="max-w-xl space-y-4 text-sm text-neutral-700">
      <section className="rounded-lg border border-neutral-200 p-4">
        <div className="text-base font-medium">hu-agent 客户端</div>
        <div className="mt-1 text-xs text-neutral-400">v{version} · Electron + React + TypeScript</div>
      </section>

      <section className="rounded-lg border border-neutral-200 p-4 text-xs leading-relaxed">
        <div className="mb-2 text-xs font-semibold text-neutral-500">诊断</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={exporting}
            onClick={() => void exportDiagnostics()}
            className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-100 disabled:opacity-40"
          >
            {exporting ? '导出中…' : '导出诊断包'}
          </button>
          <span className="text-neutral-400">日志（10MB × 5 滚动）与本地配置，自动脱敏且不含密钥库</span>
        </div>
        {exportMessage && <p className="mt-2 break-all text-neutral-500">{exportMessage}</p>}
      </section>

      <section className="rounded-lg border border-neutral-200 p-4 text-xs leading-relaxed">
        <div className="mb-2 text-xs font-semibold text-neutral-500">文档</div>
        <ul className="space-y-1">
          <li>
            <code>docs/design.md</code> — 设计基线
          </li>
          <li>
            <code>docs/plan.md</code> — 执行计划与验收
          </li>
          <li>
            <code>docs/adr/</code> — 关键决策记录
          </li>
        </ul>
      </section>

      <section className="rounded-lg border border-neutral-200 p-4 text-xs leading-relaxed text-neutral-500">
        <div className="mb-2 text-xs font-semibold text-neutral-500">本地数据位置</div>
        <ul className="space-y-1">
          <li>
            配置与密钥：<code>~/.hu-agent/</code>（密钥经 safeStorage 加密）
          </li>
          <li>
            会话与审计：<code>&lt;workspace&gt;/.hu/</code>
          </li>
        </ul>
      </section>
    </div>
  )
}
