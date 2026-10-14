import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentEvent, ApprovalRequestView, GuideRequestView } from '@shared/events'
import type {
  ModelOptionView,
  SessionItemView,
  SessionMetaView,
  SessionOptionsView,
  SessionSearchHitView,
  SessionUsageView,
  UsageStatsView,
  WorkspaceInfoView,
} from '@shared/ipc'

import ChatView from './components/ChatView'
import LoginGate from './components/LoginGate'
import ProfileDialog from './components/ProfileDialog'
import Sidebar from './components/Sidebar'
import TopTabs, { type AppTab } from './components/TopTabs'
import AboutSection from './components/settings/AboutSection'
import MarketSection from './components/settings/MarketSection'
import McpSection from './components/settings/McpSection'
import ModelSection from './components/settings/ModelSection'
import PermissionSection from './components/settings/PermissionSection'
import SkillsSection from './components/settings/SkillsSection'
import StatsSection from './components/settings/StatsSection'
import SyncSection from './components/settings/SyncSection'
import WorkspaceSection from './components/settings/WorkspaceSection'
import { applyResolved, t, useI18n } from './i18n'

export default function App() {
  // 订阅语言：切换语言时由根组件带动整树重渲染（design 5.13）
  useI18n()
  const [sessions, setSessions] = useState<SessionMetaView[]>([])
  const [currentId, setCurrentId] = useState<string | null>(null)
  const [items, setItems] = useState<SessionItemView[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [streamingReasoning, setStreamingReasoning] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<AppTab>('chat')
  const [profileOpen, setProfileOpen] = useState(false)
  const [accountName, setAccountName] = useState<string | null>(null)
  const [sessionState, setSessionState] = useState<'loading' | 'required' | 'ready'>('loading')
  const [gateNotice, setGateNotice] = useState<string | null>(null)
  const [gateRetryOnly, setGateRetryOnly] = useState(false)
  const [usage, setUsage] = useState<UsageStatsView | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceInfoView | null>(null)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfoView[]>([])
  const [searchHits, setSearchHits] = useState<SessionSearchHitView[]>([])
  const [models, setModels] = useState<ModelOptionView[]>([])
  const [options, setOptions] = useState<SessionOptionsView | null>(null)
  const [stats, setStats] = useState<SessionUsageView | null>(null)
  const [approval, setApproval] = useState<ApprovalRequestView | null>(null)
  const [guide, setGuide] = useState<GuideRequestView | null>(null)
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
    setApproval(null)
    setGuide(null)
    setItems(await window.huAgent.sessions.items(sessionId))
    setOptions(await window.huAgent.sessions.options(sessionId))
    setStats(await window.huAgent.sessions.stats(sessionId))
  }, [])

  const createSession = useCallback(async (): Promise<void> => {
    const created = await window.huAgent.sessions.create()
    await refreshSessions()
    await openSession(created.id)
  }, [openSession, refreshSessions])

  /** 加载当前工作空间下的会话（无会话时新建一个）。 */
  const loadWorkspaceState = useCallback(
    async (target: WorkspaceInfoView): Promise<void> => {
      setWorkspace(target)
      const list = await refreshSessions()
      if (list.length === 0) {
        const created = await window.huAgent.sessions.create()
        await refreshSessions()
        await openSession(created.id)
      } else {
        await openSession(list[0]?.id ?? '')
      }
      setSearchHits([])
    },
    [openSession, refreshSessions],
  )

  /** 登录成功后加载工作空间、会话、模型与账号状态（design 4.1 + D16）。 */
  const loadSessionData = useCallback(async (): Promise<void> => {
    const [list, active] = await Promise.all([window.huAgent.workspace.list(), window.huAgent.workspace.active()])
    setWorkspaces(list)
    await loadWorkspaceState(active)
    setUsage(await window.huAgent.usage.stats())
    const view = await window.huAgent.settings.get()
    setModels(view.availableModels)
    const cloud = await window.huAgent.cloud.status()
    setAccountName(cloud.loggedIn && cloud.user ? cloud.user.displayName || cloud.user.email : null)
  }, [loadWorkspaceState])

  /** 启动门禁探测：未登录/会话失效一律停在上登录页（不能绕过）。 */
  const probeSession = useCallback(async (): Promise<void> => {
    setSessionState('loading')
    const result = await window.huAgent.cloud.session()
    if (result.loggedIn) {
      setGateNotice(null)
      setGateRetryOnly(false)
      await loadSessionData()
      setSessionState('ready')
      return
    }
    setGateNotice(result.error ?? null)
    setGateRetryOnly(!result.needsLogin && Boolean(result.error))
    setSessionState('required')
  }, [loadSessionData])

  useEffect(() => {
    void probeSession()
  }, [probeSession])

  /** 启动时同步语言（偏好存 config.json，默认跟随系统，design 5.13） */
  useEffect(() => {
    void window.huAgent.settings.getLocale().then((locale) => {
      applyResolved(locale.preference, locale.resolved)
    })
  }, [])

  // 服务端拒绝会话（令牌撤销/账号禁用）：立即退回门禁
  useEffect(
    () =>
      window.huAgent.cloud.onSessionLost((reason) => {
        setGateNotice(reason)
        setGateRetryOnly(false)
        setSessionState('required')
      }),
    [],
  )

  useEffect(() => {
    const off = window.huAgent.agent.onEvent((event: AgentEvent) => {
      // 授权/提问不按当前会话过滤：后台会话的请求也要能应答，否则会一直挂起
      if (event.type === 'tool.approval_required') {
        setApproval(event.request)
        return
      }
      if (event.type === 'ask_guide') {
        setGuide(event.request)
        return
      }
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
          setApproval((prev) => (prev && prev.sessionId === event.sessionId ? null : prev))
          setGuide((prev) => (prev && prev.sessionId === event.sessionId ? null : prev))
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
        { kind: 'message', id: `user_${Date.now()}`, role: 'user', text, createdAt: new Date().toISOString() },
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

  const decideApproval = useCallback(
    (choice: 'allow_once' | 'allow_session' | 'allow_always' | 'deny'): void => {
      if (!approval) return
      void window.huAgent.agent.decideApproval(approval.id, choice)
      setApproval(null)
    },
    [approval],
  )

  const answerGuide = useCallback(
    (value: string): void => {
      if (!guide) return
      void window.huAgent.agent.answerGuide(guide.id, value)
      setGuide(null)
    },
    [guide],
  )

  const switchWorkspace = useCallback(
    async (id: string): Promise<void> => {
      if (!id || id === workspace?.id) return
      const target = await window.huAgent.workspace.setActive(id)
      setWorkspaces(await window.huAgent.workspace.list())
      await loadWorkspaceState(target)
    },
    [loadWorkspaceState, workspace?.id],
  )

  const pickWorkspace = useCallback(async (): Promise<void> => {
    const picked = await window.huAgent.workspace.pick()
    if (!picked) return
    setWorkspaces(await window.huAgent.workspace.list())
    await loadWorkspaceState(picked)
  }, [loadWorkspaceState])

  const search = useCallback(async (query: string): Promise<void> => {
    if (!query.trim()) {
      setSearchHits([])
      return
    }
    setSearchHits(await window.huAgent.sessions.search(query))
  }, [])

  /** 配置变更后同步用量、可选模型、会话统计与账户状态。 */
  const refreshDerived = useCallback((): void => {
    void window.huAgent.usage.stats().then(setUsage)
    void window.huAgent.settings.get().then((view) => setModels(view.availableModels))
    void window.huAgent.cloud.status().then((cloud) => {
      setAccountName(cloud.loggedIn && cloud.user ? cloud.user.displayName || cloud.user.email : null)
      // 主动登出后回到门禁（强制登录，ADR 0004）
      if (!cloud.loggedIn) {
        setGateNotice(null)
        setGateRetryOnly(false)
        setSessionState('required')
      }
    })
    if (currentId) void window.huAgent.sessions.stats(currentId).then(setStats)
  }, [currentId])

  if (sessionState === 'loading') {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-neutral-100 text-sm text-neutral-500">
        {t('正在连接服务端…')}
      </div>
    )
  }

  if (sessionState === 'required') {
    return (
      <LoginGate
        notice={gateNotice}
        retryOnly={gateRetryOnly}
        onLoggedIn={() => void probeSession()}
        onRetry={() => void probeSession()}
      />
    )
  }

  return (
    <div className="flex h-screen w-screen bg-neutral-100 text-neutral-900">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        workspace={workspace}
        workspaces={workspaces}
        searchHits={searchHits}
        accountLabel={accountName ?? t('未登录')}
        onSelect={(id) => void openSession(id)}
        onNew={() => void createSession()}
        onOpenProfile={() => setProfileOpen(true)}
        onSwitchWorkspace={(id) => void switchWorkspace(id)}
        onPickWorkspace={() => void pickWorkspace()}
        onSearch={(query) => void search(query)}
        onOpenHit={(sessionId) => void openSession(sessionId)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopTabs active={tab} onChange={setTab} />

        {/* 对话页始终挂载，仅隐藏：避免切换 tab 丢失流式状态 */}
        <div className={tab === 'chat' ? 'flex min-h-0 min-w-0 flex-1 flex-col' : 'hidden'}>
          <ChatView
            items={items}
            streamingText={streamingText}
            streamingReasoning={streamingReasoning}
            running={running}
            error={error}
            models={models}
            options={options}
            stats={stats}
            approval={approval}
            guide={guide}
            onOptionsChange={(next) => void changeOptions(next)}
            onSend={(text) => void send(text)}
            onStop={stop}
            onDecideApproval={decideApproval}
            onAnswerGuide={answerGuide}
          />
        </div>

        {tab !== 'chat' && (
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="mx-auto max-w-3xl">
              {tab === 'models' && <ModelSection onChanged={refreshDerived} />}
              {tab === 'market' && <MarketSection onChanged={refreshDerived} />}
              {tab === 'skills' && <SkillsSection onChanged={refreshDerived} />}
              {tab === 'mcp' && <McpSection onChanged={refreshDerived} />}
              {tab === 'workspace' && (
                <WorkspaceSection
                  workspaces={workspaces}
                  activeWorkspace={workspace}
                  onSwitch={(id) => void switchWorkspace(id)}
                  onPick={() => void pickWorkspace()}
                />
              )}
              {tab === 'sync' && <SyncSection onChanged={refreshDerived} />}
              {tab === 'stats' && <StatsSection />}
              {tab === 'permissions' && <PermissionSection />}
              {tab === 'about' && <AboutSection />}
            </div>
          </div>
        )}
      </div>

      {profileOpen && (
        <ProfileDialog
          usage={usage}
          workspaces={workspaces}
          activeWorkspace={workspace}
          onClose={() => setProfileOpen(false)}
          onChanged={refreshDerived}
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
