import { useCallback, useEffect, useState } from 'react'

import type { ApiTypeView, ModelEntryView, SettingsView } from '@shared/ipc'
import { t } from '../../i18n'

interface FormState {
  id: string
  apiType: ApiTypeView
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
  apiType: 'openai-chat',
  baseUrl: '',
  apiKey: '',
  modelName: '',
  contextWindow: '128000',
  supportsTools: true,
  supportsReasoning: false,
  isPrimary: true,
}

export default function ModelSection({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)

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
      apiType: provider.apiType,
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
      setMessage(t('请填写供应商 ID、Base URL 与模型名称'))
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
      await window.huAgent.settings.saveProvider({
        id: form.id.trim(),
        apiType: form.apiType,
        baseUrl: form.baseUrl.trim(),
        models,
        apiKey: form.apiKey,
      })
      if (form.isPrimary) {
        await window.huAgent.settings.setDefault('primary', `${form.id.trim()}/${form.modelName.trim()}`)
        await window.huAgent.settings.setDefault('fast', `${form.id.trim()}/${form.modelName.trim()}`)
      }
      await refresh()
      setForm({ ...form, apiKey: '' })
      setMessage(t('已保存'))
      onChanged()
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <section>
        <h3 className="mb-2 text-xs font-semibold text-fg-muted">{t('已配置供应商')}</h3>
        {settings?.providers.length ? (
          <ul className="space-y-2">
            {settings.providers.map((provider) => (
              <li key={provider.id} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-xs">
                <div>
                  <div className="font-medium">
                    {provider.id}
                    <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-fg-muted">{provider.apiType}</span>
                    {settings.defaults.primary.startsWith(`${provider.id}/`) && (
                      <span className="ml-2 rounded bg-success-soft px-1.5 py-0.5 text-[10px] text-success">primary</span>
                    )}
                  </div>
                  <div className="text-fg-subtle">
                    {provider.baseUrl} · {provider.models.map((model) => model.name).join(', ')}
                    {provider.apiKeyRef && settings.secretsConfigured[provider.apiKeyRef] ? t(' · 已配置密钥') : ''}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" className="text-accent hover:underline" onClick={() => edit(provider.id)}>
                    {t('编辑')}
                  </button>
                  <button
                    type="button"
                    className="text-danger hover:underline"
                    onClick={() => void window.huAgent.settings.removeProvider(provider.id).then(setSettings)}
                  >
                    {t('删除')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-subtle">{t('尚未配置模型供应商')}</p>
        )}
      </section>

      <section className="space-y-2 rounded-lg border border-line p-3">
        <h3 className="text-xs font-semibold text-fg-muted">{t('新增 / 编辑供应商')}</h3>
        <input
          className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
          placeholder={t("供应商 ID（如 openai、deepseek-anthropic）")}
          value={form.id}
          onChange={(event) => setForm({ ...form, id: event.target.value })}
        />
        <select
          className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
          value={form.apiType}
          onChange={(event) => setForm({ ...form, apiType: event.target.value as ApiTypeView })}
        >
          <option value="openai-chat">OpenAI Chat Completions</option>
          <option value="openai-responses">OpenAI Responses</option>
          <option value="anthropic-messages">Anthropic Messages</option>
        </select>
        <input
          className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
          placeholder={t("Base URL（如 https://api.deepseek.com）")}
          value={form.baseUrl}
          onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
        />
        <input
          className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
          type="password"
          placeholder={t("API Key（留空保留原密钥；本地服务可留空）")}
          value={form.apiKey}
          onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
        />
        <input
          className="w-full rounded border border-line-strong px-2 py-1.5 text-sm"
          placeholder={t("模型名称（如 deepseek-flash）")}
          value={form.modelName}
          onChange={(event) => setForm({ ...form, modelName: event.target.value })}
        />
        <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
          <label className="flex items-center gap-1">
            {t('上下文窗口')}
            <input
              className="w-24 rounded border border-line-strong px-2 py-1"
              value={form.contextWindow}
              onChange={(event) => setForm({ ...form, contextWindow: event.target.value })}
            />
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={form.supportsTools} onChange={(event) => setForm({ ...form, supportsTools: event.target.checked })} />
            {t('支持工具')}
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={form.supportsReasoning} onChange={(event) => setForm({ ...form, supportsReasoning: event.target.checked })} />
            {t('支持思考强度')}
          </label>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={form.isPrimary} onChange={(event) => setForm({ ...form, isPrimary: event.target.checked })} />
            {t('设为默认')}
          </label>
        </div>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {saving ? t('保存中…') : t('保存供应商')}
        </button>
        {message && <p className="text-xs text-fg-muted">{message}</p>}
      </section>

      <p className="text-[11px] leading-relaxed text-fg-subtle">
        {t('密钥经 Electron safeStorage 加密后存于 ~/.hu-agent/secrets.enc.json，不会写入配置文件或日志。')}
      </p>
    </div>
  )
}
