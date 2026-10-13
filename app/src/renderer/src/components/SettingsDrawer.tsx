import { useCallback, useEffect, useState } from 'react'

import type { ModelEntryView, SettingsView } from '@shared/ipc'

interface Props {
  onClose: () => void
  onChanged: () => void
}

interface FormState {
  id: string
  baseUrl: string
  apiKey: string
  modelName: string
  contextWindow: string
  supportsTools: boolean
  supportsReasoning: boolean
  isPrimary: boolean
}

const EMPTY_FORM: FormState = {
  id: '',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  modelName: '',
  contextWindow: '128000',
  supportsTools: true,
  supportsReasoning: false,
  isPrimary: true,
}

export default function SettingsDrawer({ onClose, onChanged }: Props) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setSettings(await window.huAgent.settings.get())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const edit = (providerId: string): void => {
    const provider = settings?.providers.find((item) => item.id === providerId)
    if (!provider) return
    const model = provider.models[0]
    setForm({
      id: provider.id,
      baseUrl: provider.baseUrl,
      apiKey: '',
      modelName: model?.name ?? '',
      contextWindow: String(model?.capabilities.contextWindow ?? 32768),
      supportsTools: model?.capabilities.tools ?? true,
      supportsReasoning: model?.capabilities.reasoningEffort ?? false,
      isPrimary: settings?.defaults.primary === `${provider.id}/${model?.name ?? ''}`,
    })
  }

  const save = async (): Promise<void> => {
    if (!form.id.trim() || !form.modelName.trim() || !form.baseUrl.trim()) {
      setMessage('请填写供应商 ID、Base URL 与模型名称')
      return
    }
    setSaving(true)
    setMessage(null)
    try {
      const models: ModelEntryView[] = [
        {
          name: form.modelName.trim(),
          roles: ['primary', 'fast'],
          capabilities: {
            tools: form.supportsTools,
            reasoningEffort: form.supportsReasoning,
            contextWindow: Number(form.contextWindow) || 32768,
          },
        },
      ]
      const next = await window.huAgent.settings.saveProvider({
        id: form.id.trim(),
        baseUrl: form.baseUrl.trim(),
        models,
        apiKey: form.apiKey,
      })
      if (form.isPrimary) {
        await window.huAgent.settings.setDefault('primary', `${form.id.trim()}/${form.modelName.trim()}`)
        await window.huAgent.settings.setDefault('fast', `${form.id.trim()}/${form.modelName.trim()}`)
      }
      setSettings(await window.huAgent.settings.get())
      setForm({ ...EMPTY_FORM })
      setMessage(`已保存（返回 ${next.providers.length} 个供应商）`)
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    setSettings(await window.huAgent.settings.removeProvider(id))
    onChanged()
  }

  return (
    <div className="fixed inset-0 z-10 flex justify-end bg-black/30" onClick={onClose}>
      <div
        className="flex h-full w-[480px] flex-col overflow-y-auto bg-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <span className="text-sm font-semibold">模型设置</span>
          <button type="button" onClick={onClose} className="text-neutral-500 hover:text-neutral-900">
            关闭
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold text-neutral-500">已配置供应商</h3>
            {settings?.providers.length ? (
              <ul className="space-y-2">
                {settings.providers.map((provider) => (
                  <li
                    key={provider.id}
                    className="flex items-center justify-between rounded-md border border-neutral-200 px-3 py-2 text-xs"
                  >
                    <div>
                      <div className="font-medium">
                        {provider.id}
                        {settings.defaults.primary.startsWith(`${provider.id}/`) && (
                          <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">primary</span>
                        )}
                      </div>
                      <div className="text-neutral-400">
                        {provider.baseUrl} · {provider.models.map((model) => model.name).join(', ')}
                        {provider.apiKeyRef && settings.secretsConfigured[provider.apiKeyRef] ? ' · 已配置密钥' : ''}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button type="button" className="text-blue-600 hover:underline" onClick={() => edit(provider.id)}>
                        编辑
                      </button>
                      <button type="button" className="text-rose-600 hover:underline" onClick={() => void remove(provider.id)}>
                        删除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-neutral-400">尚未配置模型供应商</p>
            )}
          </section>

          <section className="space-y-2 rounded-lg border border-neutral-200 p-3">
            <h3 className="text-xs font-semibold text-neutral-500">新增 / 编辑供应商</h3>
            <input
              className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
              placeholder="供应商 ID（如 openai、ollama）"
              value={form.id}
              onChange={(event) => setForm({ ...form, id: event.target.value })}
            />
            <input
              className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
              placeholder="Base URL（如 https://api.openai.com/v1）"
              value={form.baseUrl}
              onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
            />
            <input
              className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
              type="password"
              placeholder="API Key（留空保留原密钥；本地服务可留空）"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
            />
            <input
              className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
              placeholder="模型名称（如 gpt-4o-mini、qwen2.5:7b）"
              value={form.modelName}
              onChange={(event) => setForm({ ...form, modelName: event.target.value })}
            />
            <div className="flex items-center gap-3 text-xs text-neutral-600">
              <label className="flex items-center gap-1">
                上下文窗口
                <input
                  className="w-24 rounded border border-neutral-300 px-2 py-1"
                  value={form.contextWindow}
                  onChange={(event) => setForm({ ...form, contextWindow: event.target.value })}
                />
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.supportsTools}
                  onChange={(event) => setForm({ ...form, supportsTools: event.target.checked })}
                />
                支持工具
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.supportsReasoning}
                  onChange={(event) => setForm({ ...form, supportsReasoning: event.target.checked })}
                />
                支持思考强度
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  onChange={(event) => setForm({ ...form, isPrimary: event.target.checked })}
                />
                设为默认
              </label>
            </div>
            <button
              type="button"
              disabled={saving}
              onClick={() => void save()}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700 disabled:opacity-40"
            >
              {saving ? '保存中…' : '保存供应商'}
            </button>
            {message && <p className="text-xs text-neutral-500">{message}</p>}
          </section>

          <p className="text-[11px] leading-relaxed text-neutral-400">
            密钥经 Electron safeStorage 加密后存于 ~/.hu-agent/secrets.enc.json，不会写入配置文件或日志。
          </p>
        </div>
      </div>
    </div>
  )
}
