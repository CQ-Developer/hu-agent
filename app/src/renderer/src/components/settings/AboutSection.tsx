import { useEffect, useState } from 'react'
import { t } from '../../i18n'

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
        result.canceled ? null : t('已导出 {files} 个文件到 {path}（密钥已脱敏）', { files: result.files, path: result.path }),
      )
    } catch (cause) {
      setExportMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="max-w-xl space-y-4 text-sm text-fg">
      <section className="rounded-lg border border-line p-4">
        <div className="text-base font-medium">{t('hu-agent 客户端')}</div>
        <div className="mt-1 text-xs text-fg-subtle">v{version} · Electron + React + TypeScript</div>
      </section>

      <section className="rounded-lg border border-line p-4 text-xs leading-relaxed">
        <div className="mb-2 text-xs font-semibold text-fg-muted">{t('诊断')}</div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={exporting}
            onClick={() => void exportDiagnostics()}
            className="rounded-md border border-line-strong px-3 py-1.5 hover:bg-surface-2 disabled:opacity-40"
          >
            {exporting ? t('导出中…') : t('导出诊断包')}
          </button>
          <span className="text-fg-subtle">{t('日志（10MB × 5 滚动）与本地配置，自动脱敏且不含密钥库')}</span>
        </div>
        {exportMessage && <p className="mt-2 break-all text-fg-muted">{exportMessage}</p>}
      </section>

      <section className="rounded-lg border border-line p-4 text-xs leading-relaxed">
        <div className="mb-2 text-xs font-semibold text-fg-muted">{t('文档')}</div>
        <ul className="space-y-1">
          <li>
            <code>docs/design.md</code> {t('— 设计基线')}
          </li>
          <li>
            <code>docs/plan.md</code> {t('— 执行计划与验收')}
          </li>
          <li>
            <code>docs/adr/</code> {t('— 关键决策记录')}
          </li>
        </ul>
      </section>

      <section className="rounded-lg border border-line p-4 text-xs leading-relaxed text-fg-muted">
        <div className="mb-2 text-xs font-semibold text-fg-muted">{t('本地数据位置')}</div>
        <ul className="space-y-1">
          <li>
            {t('配置与密钥：')}<code>~/.hu-agent/</code>{t('（密钥经 safeStorage 加密）')}
          </li>
          <li>
            {t('会话与审计：')}<code>&lt;workspace&gt;/.hu/</code>
          </li>
        </ul>
      </section>
    </div>
  )
}
