import { useEffect, useState } from 'react'

export default function AboutSection() {
  const [version, setVersion] = useState('-')

  useEffect(() => {
    void window.huAgent.getVersion().then(setVersion)
  }, [])

  return (
    <div className="max-w-xl space-y-4 text-sm text-neutral-700">
      <section className="rounded-lg border border-neutral-200 p-4">
        <div className="text-base font-medium">hu-agent 客户端</div>
        <div className="mt-1 text-xs text-neutral-400">v{version} · Electron + React + TypeScript</div>
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
