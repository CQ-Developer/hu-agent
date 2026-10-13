export default function McpSection() {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-4 text-xs text-neutral-500">
      <div className="font-medium text-neutral-700">MCP 配置（阶段 3 后半提供）</div>
      <p className="mt-1 leading-relaxed">
        将支持：本地/工作空间两级 MCP 配置、stdio 与 HTTP/SSE 传输、连接测试与工具列表预览、
        密钥经 safeStorage 存储（配置里只保留 secret:// 引用）。
      </p>
    </div>
  )
}
