import type { UsageStatsView, WorkspaceInfoView } from '@shared/ipc'

interface Props {
  usage: UsageStatsView | null
  workspaces: WorkspaceInfoView[]
  activeWorkspace: WorkspaceInfoView | null
}

export default function ProfileSection({ usage, workspaces, activeWorkspace }: Props) {
  return (
    <div className="space-y-5">
      <section className="flex items-center gap-3 rounded-lg border border-neutral-200 p-4">
        <div className="grid h-12 w-12 place-items-center rounded-full bg-neutral-200 text-lg">👤</div>
        <div>
          <div className="text-sm font-medium">本地用户</div>
          <div className="text-xs text-neutral-400">未登录（企业账号与 SSO 在阶段 5 接入）</div>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">本地用量</h3>
        {usage ? (
          <div className="rounded-lg border border-neutral-200 p-3">
            <div className="flex gap-6 text-xs">
              <div>
                <div className="text-neutral-400">调用次数</div>
                <div className="text-lg">{usage.calls}</div>
              </div>
              <div>
                <div className="text-neutral-400">输入 tokens</div>
                <div className="text-lg">{usage.inputTokens}</div>
              </div>
              <div>
                <div className="text-neutral-400">输出 tokens</div>
                <div className="text-lg">{usage.outputTokens}</div>
              </div>
              <div>
                <div className="text-neutral-400">失败</div>
                <div className="text-lg">{usage.errors}</div>
              </div>
            </div>
            {Object.keys(usage.byModel).length > 0 && (
              <table className="mt-3 w-full text-xs">
                <thead className="text-left text-neutral-400">
                  <tr>
                    <th className="py-1">模型</th>
                    <th>调用</th>
                    <th>输入</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(usage.byModel).map(([model, item]) => (
                    <tr key={model} className="border-t border-neutral-100">
                      <td className="py-1 font-mono">{model}</td>
                      <td>{item.calls}</td>
                      <td>{item.inputTokens}</td>
                      <td>{item.outputTokens}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : (
          <p className="text-xs text-neutral-400">暂无用量记录</p>
        )}
        <p className="mt-1 text-[11px] text-neutral-400">
          用量上报（服务端）在阶段 4 接入；当前数据仅保存在本机 ~/.hu-agent/usage/ledger.jsonl。
        </p>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold text-neutral-500">工作空间</h3>
        <div className="rounded-lg border border-neutral-200 p-3 text-xs">
          <div>
            共 {workspaces.length} 个，当前：{activeWorkspace?.name ?? '-'}
          </div>
          {activeWorkspace && <div className="mt-1 truncate text-neutral-400">{activeWorkspace.root}</div>}
        </div>
      </section>
    </div>
  )
}
