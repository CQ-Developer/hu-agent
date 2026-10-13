import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentEvent } from '@shared/events'
import type {
  ModelOptionView,
  SessionItemView,
  SessionMetaView,
  SessionOptionsView,
  SessionUsageView,
  UsageStatsView,
  WorkspaceInfoView,
} from '@shared/ipc'

import ChatView from './components/ChatView'
import SettingsDrawer from './components/SettingsDrawer'
import Sidebar from './components/Sidebar'

export default function App() {
  const [sessions, setSessions] = useState<SessionMetaView[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [items, setItems] = useState<SessionItemView[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usage, setUsage] = useState<UsageStatsView | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceInfoView | null>(null)
  const [models, setModels] = useState<ModelOptionView[]>([])
  const [options, setOptions] = useState<SessionOptionsView | null>(null)
  const [stats, setStats] = useState<SessionUsageView | null>(null)
  const streamingRef = useRef('')
  const reasoningRef = useRef('')

  const refreshSessions = useCallback(async (): Promise<SessionMetaView[]> => {
    const list = await window.huAgent.sessions.list()
    setSessions(list)
    return list
  }, [])

  const openSession = useCallback(async (sessionId: string): Promise<void> => {
    setCurrentId(sessionId)
    streamingRef.current = ''
    reasoningRef.current = ''
    setStreamingText('')
    setStreamingReasoning('')
    setError(null)
    setItems(await window.huAgent.sessions.items(sessionId))
    setOptions(await window.huAgent.sessions.options(sessionId))
    setStats(await window.huAgent.sessions.stats(sessionId))
  }, [])

  const createSession = useCallback(async (): Promise<void> => {
    const created = await window.huAgent.sessions.create()
    await refreshSessions()
    await openSession(created.id)
  }, [openSession, refreshSessions])

  useEffect(() => {
    void (async () => {
      const list = await refreshSessions()
      if (list.length === 0) {
        const created = await window.huAgent.sessions.create()
        await refreshSessions()
        await openSession(created.id)
      } else {
        await openSession(list[0].id)
      }
      setWorkspace(await window.huAgent.workspace.info())
      setUsage(await window.huAgent.usage.stats())
      const view = await window.huAgent.settings.get()
      setModels(view.availableModels)
    })()
  }, [openSession, refreshSessions])

  useEffect(() => {
    const off = window.huAgent.agent.onEvent((event: AgentEvent) => {
      if (event.sessionId !== currentId) return
      switch (event.type) {
        case 'turn.start':
          setRunning(true)
          setError(null)
          streamingRef.current = ''
          reasoningRef.current = ''
          setStreamingText('')
          setStreamingReasoning('')
          break
        case 'assistant.delta':
          streamingRef.current += event.text
          setStreamingText(streamingRef.current)
          break
        case 'reasoning.delta':
          reasoningRef.current += event.text
          setStreamingReasoning(reasoningRef.current)
          break
        case 'tool.call': {
          const text = streamingRef.current
          const reasoning = reasoningRef.current
          streamingRef.current = ''
          reasoningRef.current = ''
          setStreamingText('')
          setStreamingReasoning('')
          setItems((prev) => [
            ...prev,
            ...(text || reasoning
              ? [
                  {
                    kind: 'message' as const,
                    id: `stream_${event.turnId}`,
                    role: 'assistant' as const,
                    text,
                    reasoning: reasoning || undefined,
                    createdAt: new Date().toISOString(),
                  },
                ]
              : []),
            {
              kind: 'tool' as const,
              id: event.call.id,
              name: event.call.name,
              input: event.call.input,
              createdAt: new Date().toISOString(),
            },
          ])
          break
        }
        case 'tool.result':
          setItems((prev) =>
            prev.map((item) =>
              item.kind === 'tool' && item.id === event.result.id
                ? {
                    ...item,
                    status: event.result.status,
                    output: event.result.output,
                    durationMs: event.result.durationMs,
                    truncated: event.result.truncated,
                    artifactPath: event.result.artifactPath,
                  }
                : item,
            ),
          )
          break
        case 'usage.update':
          setStats((prev) => applyUsage(prev, event.usage, models, options))
          break
        case 'turn.end': {
          const text = streamingRef.current
          const reasoning = reasoningRef.current
          streamingRef.current = ''
          reasoningRef.current = ''
          setStreamingText('')
          setStreamingReasoning('')
          setRunning(false)
          if (text || reasoning) {
            setItems((prev) => [
              ...prev,
              {
                kind: 'message',
                id: `stream_end_${event.turnId}`,
                role: 'assistant',
                text,
                reasoning: reasoning || undefined,
                createdAt: new Date().toISOString(),
              },
            ])
          }
          if (event.stopReason === 'error' && event.error) setError(event.error)
          void refreshSessions()
          void window.huAgent.usage.stats().then(setUsage)
          void window.huAgent.sessions.stats(event.sessionId).then(setStats)
          break
        }
      }
    })
    return off
  }, [currentId, models, options, refreshSessions])

  const changeOptions = useCallback(
    async (next: SessionOptionsView): Promise<void> => {
      if (!currentId) return
      setOptions(await window.huAgent.sessions.setOptions(currentId, next))
    },
    [currentId],
  )

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (!currentId || !text.trim() || running) return
      setItems((prev) => [
        ...prev,
        {
          kind: 'message',
          id: `user_${Date.now()}`,
          role: 'user',
          text,
          createdAt: new Date().toISOString(),
        },
      ])
      setRunning(true)
      setError(null)
      try {
        await window.huAgent.agent.send(currentId, text)
      } catch (cause) {
        setRunning(false)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [currentId, running],
  )

  const stop = useCallback((): void => {
    if (currentId) void window.huAgent.agent.cancel(currentId)
  }, [currentId])

  return (
    <div className="flex h-screen w-screen bg-neutral-100 text-neutral-900">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        usage={usage}
        workspace={workspace}
        onSelect={(id) => void openSession(id)}
        onNew={() => void createSession()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <ChatView
        items={items}
        streamingText={streamingText}
        streamingReasoning={streamingReasoning}
        running={running}
        error={error}
        models={models}
        options={options}
        stats={stats}
        onOptionsChange={(next) => void changeOptions(next)}
        onSend={(text) => void send(text)}
        onStop={stop}
      />
      {settingsOpen && (
        <SettingsDrawer
          onClose={() => setSettingsOpen(false)}
          onChanged={() => {
            void window.huAgent.usage.stats().then(setUsage)
            void window.huAgent.settings.get().then((view) => setModels(view.availableModels))
            if (currentId) void window.huAgent.sessions.stats(currentId).then(setStats)
          }}
        />
      )}
    </div>
  )
}

/** 用 usage.update 事件实时累加会话统计（turn.end 时再用 IPC 校准）。 */
function applyUsage(
  prev: SessionUsageView | null,
  incoming: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
  models: ModelOptionView[],
  options: SessionOptionsView | null,
): SessionUsageView {
  const contextWindow =
    models.find((model) => model.target === options?.model)?.contextWindow ?? prev?.contextWindow ?? 0
  const calls = (prev?.calls ?? 0) + 1
  const inputTokens = (prev?.inputTokens ?? 0) + incoming.inputTokens
  const outputTokens = (prev?.outputTokens ?? 0) + incoming.outputTokens
  const cacheReadTokens = (prev?.cacheReadTokens ?? 0) + (incoming.cacheReadTokens ?? 0)
  const used = incoming.inputTokens + incoming.outputTokens
  return {
    calls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheHitRate: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
    contextWindow,
    contextRemainingPercent:
      contextWindow > 0 ? Math.max(0, Math.min(1, 1 - used / contextWindow)) * 100 : 100,
  }
}
