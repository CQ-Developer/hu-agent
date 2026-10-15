import { useCallback, useEffect, useState } from 'react'

import type { McpSaveInput, McpServerView, McpTestResultView } from '@shared/ipc'
import { t } from '../../i18n'

interface FormState {
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command: string
  argsText: string
  url: string
  envText: string
  headersText: string
  approval: 'ask' | 'session' | 'always'
  scope: 'global' | 'workspace'
}

const EMPTY_FORM: FormState = {
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  url: '',
  envText: '',
  headersText: '',
  approval: 'ask',
  scope: 'global',
}

const STATUS_TEXT: Record<McpServerView['status'], string> = {
  disabled: t('未启用'),
  idle: t('未连接'),
  connecting: t('连接中'),
  connected: t('已连接'),
  error: t('错误'),
}

export default function McpSection({ onChanged }: { onChanged: () => void }) {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<{ name: string; result: McpTestResultView } | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setServers(await window.huAgent.mcp.list())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const edit = (server: McpServerView): void => {
    setForm({
      name: server.name,
      transport: server.transport,
      command: server.command ?? '',
      argsText: server.args.join('\n'),
      url: server.url ?? '',
      envText: Object.entries(server.env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      headersText: Object.entries(server.headers)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
      approval: server.approval,
      scope: server.scope === 'workspace' ? 'workspace' : 'global',
    })
    setMessage(null)
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const input: McpSaveInput = {
        name: form.name.trim(),
        transport: form.transport,
        command: form.command.trim() || undefined,
        args: form.argsText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        url: form.url.trim() || undefined,
        env: parseKeyValues(form.envText),
        headers: parseKeyValues(form.headersText),
        approval: form.approval,
        scope: form.scope,
      }
      setServers(await window.huAgent.mcp.save(input))
      setMessage(`已保存到${form.scope === 'global' ? t('全局') : t('当前工作空间')}配置`)
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const test = async (name: string): Promise<void> => {
    setBusy(true)
    setTestResult(null)
    try {
      const result = await window.huAgent.mcp.test(name)
      setTestResult({ name, result })
      await refresh()
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {t('配置位置：全局')} <code>~/.hu-agent/mcp.json</code>{t('，工作空间')} <code>&lt;workspace&gt;/.hu/mcp.json</code>
        {t('（同名按字段覆盖）。工具以')} <code>mcp__&lt;server&gt;__&lt;tool&gt;</code> {t('注入模型，调用默认本会话首次询问； 空闲 10 分钟回收子进程，崩溃自动重连。env/headers 中的密钥写入 safeStorage 密钥库，配置文件只保留')}{' '}
        <code>secret://</code> {t('引用。')}
      </p>

      {servers.length === 0 && (
        <div className="rounded-lg border border-dashed border-line-strong p-4 text-xs text-fg-subtle">
          {t('尚未配置 MCP server。可在下方添加，例如 filesystem：')}
          <code className="ml-1">{t('npx -y @modelcontextprotocol/server-filesystem &lt;目录&gt;')}</code>
        </div>
      )}

      {servers.map((server) => (
        <div key={`${server.scope}/${server.name}`} className="rounded-lg border border-line p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{server.name}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">{server.transport}</span>
                <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">
                  {server.scope === 'both' ? t('全局+工作空间') : server.scope === 'global' ? t('全局') : t('工作空间')}
                </span>
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    server.status === 'connected'
                      ? 'bg-success-soft text-success'
                      : server.status === 'error'
                        ? 'bg-danger-soft text-danger'
                        : server.status === 'disabled'
                          ? 'bg-surface-2 text-fg-muted'
                          : 'bg-warning-soft text-warning'
                  }`}
                >
                  {STATUS_TEXT[server.status]}
                  {server.status === 'connected' ? t(' · {toolCount} 个工具', { toolCount: server.toolCount }) : ''}
                </span>
              </div>
              <div className="mt-1 truncate text-xs text-fg-muted" title={server.summary}>
                {server.summary || t('（无 command/url）')}
              </div>
              {server.lastError && <div className="mt-1 text-[11px] text-danger">{server.lastError}</div>}
              {(server.envKeys.length > 0 || server.headerKeys.length > 0) && (
                <div className="mt-1 text-[11px] text-fg-subtle">
                  {t('密钥项：')}{[...server.envKeys, ...server.headerKeys].join(', ')}
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-xs">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={server.enabledGlobal}
                  disabled={server.scope === 'workspace'}
                  onChange={(event) =>
                    void window.huAgent.mcp
                      .setEnabled(server.name, 'global', event.target.checked)
                      .then(setServers)
                      .then(() => onChanged())
                  }
                />
                {t('全局启用')}
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={server.enabledWorkspace}
                  onChange={(event) =>
                    void window.huAgent.mcp
                      .setEnabled(server.name, 'workspace', event.target.checked)
                      .then(setServers)
                      .then(() => onChanged())
                  }
                />
                {t('本工作空间启用')}
              </label>
              <div className="flex gap-2 pt-1">
                <button type="button" className="text-accent hover:underline" onClick={() => edit(server)}>
                  {t('编辑')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="text-accent hover:underline disabled:opacity-40"
                  onClick={() => void test(server.name)}
                >
                  {t('测试连接')}
                </button>
                <button
                  type="button"
                  className="text-danger hover:underline"
                  onClick={() =>
                    void window.huAgent.mcp
                      .remove(server.name, server.scope === 'workspace' ? 'workspace' : 'global')
                      .then(setServers)
                      .then(() => onChanged())
                  }
                >
                  {t('删除')}
                </button>
              </div>
            </div>
          </div>

          {testResult?.name === server.name && (
            <div
              className={`mt-2 rounded-md px-3 py-2 text-xs ${
                testResult.result.ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
              }`}
            >
              {testResult.result.ok
                ? `连接成功，发现 ${testResult.result.toolCount} 个工具：${testResult.result.tools.map((tool) => tool.name).join(', ') || t('（无）')}`
                : `连接失败：${testResult.result.error ?? t('未知错误')}`}
            </div>
          )}
        </div>
      ))}

      <section className="space-y-2 rounded-lg border border-line p-3">
        <h3 className="text-xs font-semibold text-fg-muted">{t('新增 / 编辑 MCP server')}</h3>
        <div className="flex gap-2">
          <input
            className="flex-1 rounded border border-line-strong px-2 py-1.5 text-sm"
            placeholder={t("server 名称（如 filesystem）")}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
          <select
            className="rounded border border-line-strong px-2 py-1.5 text-sm"
            value={form.transport}
            onChange={(event) => setForm({ ...form, transport: event.target.value as FormState['transport'] })}
          >
            <option value="stdio">stdio</option>
            <option value="http">{t('http（阶段 3-05）')}</option>
            <option value="sse">{t('sse（阶段 3-05）')}</option>
          </select>
        </div>

        {form.transport === 'stdio' ? (
          <>
            <input
              className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
              placeholder={t("command（如 npx）")}
              value={form.command}
              onChange={(event) => setForm({ ...form, command: event.target.value })}
            />
            <textarea
              className="h-16 w-full rounded border border-line-strong px-2 py-1.5 font-mono text-xs"
              placeholder={t("参数，每行一个（如 -y）")}
              value={form.argsText}
              onChange={(event) => setForm({ ...form, argsText: event.target.value })}
            />
          </>
        ) : (
          <input
            className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
            placeholder={t("URL（如 https://mcp.example.com/mcp）")}
            value={form.url}
            onChange={(event) => setForm({ ...form, url: event.target.value })}
          />
        )}

        <textarea
          className="h-16 w-full rounded border border-line-strong px-2 py-1.5 font-mono text-xs"
          placeholder={t('环境变量，每行 KEY=value\n明文将写入 safeStorage 密钥库，配置里只保留 secret:// 引用')}
          value={form.envText}
          onChange={(event) => setForm({ ...form, envText: event.target.value })}
        />
        <textarea
          className="h-16 w-full rounded border border-line-strong px-2 py-1.5 font-mono text-xs"
          placeholder={t('HTTP 头，每行 KEY=value（可选）')}
          value={form.headersText}
          onChange={(event) => setForm({ ...form, headersText: event.target.value })}
        />

        <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
          <label className="flex items-center gap-1">
            {t('保存到')}
            <select
              className="rounded border border-line-strong px-2 py-1"
              value={form.scope}
              onChange={(event) => setForm({ ...form, scope: event.target.value as FormState['scope'] })}
            >
              <option value="global">{t('全局配置')}</option>
              <option value="workspace">{t('当前工作空间')}</option>
            </select>
          </label>
          <label className="flex items-center gap-1">
            {t('审批')}
            <select
              className="rounded border border-line-strong px-2 py-1"
              value={form.approval}
              onChange={(event) => setForm({ ...form, approval: event.target.value as FormState['approval'] })}
            >
              <option value="ask">{t('每次会话首次询问')}</option>
              <option value="session">{t('本会话放行')}</option>
              <option value="always">{t('始终放行')}</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void save()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? t('处理中…') : t('保存')}
          </button>
          <button
            type="button"
            onClick={() => {
              setForm(EMPTY_FORM)
              setMessage(null)
            }}
            className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2"
          >
            {t('清空')}
          </button>
          {message && <span className="text-xs text-fg-muted">{message}</span>}
        </div>
        <p className="text-[11px] text-fg-subtle">
          {t('审批模式当前由权限引擎统一按「本会话首次调用询问」执行；session/always 的差异化策略随阶段 5 的企业策略下发实现。')}
        </p>
      </section>

      <button type="button" onClick={() => void refresh()} className="rounded-md border border-line-strong px-3 py-1.5 text-xs hover:bg-surface-2">
        {t('刷新')}
      </button>
    </div>
  )
}

function parseKeyValues(text: string): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return Object.keys(result).length > 0 ? result : undefined
}
