import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentEvent } from '@shared/events'
import type { SessionItemView, SessionMetaView, UsageStatsView, WorkspaceInfoView } from '@shared/ipc'

import ChatView from './components/ChatView'
import SettingsDrawer from './components/SettingsDrawer'
import Sidebar from './components/Sidebar'

export default function App() {
  const [sessions, setSessions] = useState<SessionMetaView[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [items, setItems] = useState<SessionItemView[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [usage, setUsage] = useState<UsageStatsView | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceInfoView | null>(null)
  const streamingRef = useRef('')

  const refreshSessions = useCallback(async (): Promise<SessionMetaView[]> => {
    const list = await window.huAgent.sessions.list()
    setSessions(list)
    return list
  }, [])

  const openSession = useCallback(async (sessionId: string): Promise<void> => {
    setCurrentId(sessionId)
    streamingRef.current = ''
    setStreamingText('')
    setError(null)
    setItems(await window.huAgent.sessions.items(sessionId))
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
          setStreamingText('')
          break
        case 'assistant.delta':
          streamingRef.current += event.text
          setStreamingText(streamingRef.current)
          break
        case 'reasoning.delta':
          break
        case 'tool.call': {
          const text = streamingRef.current
          streamingRef.current = ''
          setStreamingText('')
          setItems((prev) => [
            ...prev,
            ...(text
              ? [
                  {
                    kind: 'message' as const,
                    id: `stream_${event.turnId}`,
                    role: 'assistant' as const,
                    text,
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
          break
        case 'turn.end': {
          const text = streamingRef.current
          streamingRef.current = ''
          setStreamingText('')
          setRunning(false)
          if (text) {
            setItems((prev) => [
              ...prev,
              {
                kind: 'message',
                id: `stream_end_${event.turnId}`,
                role: 'assistant',
                text,
                createdAt: new Date().toISOString(),
              },
            ])
          }
          if (event.stopReason === 'error' && event.error) setError(event.error)
          void refreshSessions()
          void window.huAgent.usage.stats().then(setUsage)
          break
        }
      }
    })
    return off
  }, [currentId, refreshSessions])

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
        running={running}
        error={error}
        onSend={(text) => void send(text)}
        onStop={stop}
      />
      {settingsOpen && (
        <SettingsDrawer
          onClose={() => setSettingsOpen(false)}
          onChanged={() => {
            void window.huAgent.usage.stats().then(setUsage)
          }}
        />
      )}
    </div>
  )
}
