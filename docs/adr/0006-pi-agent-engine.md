# ADR 0006：Agent 引擎全量采用 pi 组件

- 状态：已接受
- 日期：2026-10-14（v1.x 轨道 A；决策：使用 pi 提供的所有组件）

## 背景

客户端自研 Agent 层约 3k 行（`app/src/main/{agent,model,tools,session,permissions}`）：Agent 循环、三种
API 类型的 provider 与 SSE 解析、上下文压缩、工具、会话存储、权限/审批/审计。它们的价值在于治理能力，
但循环调度、模型目录、多 provider、持久化运行时这些"通用基础设施"自研成本高、演进慢。

pi（源码 `C:\Users\chen\Dev\pi`，npm 版本 1.2.0，MIT）提供 11 个包，其中与我们直接相关的是：
`pi-ai`（模型层）、`pi-agent-core`（循环 + 工具执行钩子）、`pi-mcp`、`pi-codemode`、`pi-durable` + `chord`
（持久化运行时）、`pi-env`（远程执行）、`pi-telemetry`（遥测契约）、`pi-evals`（评估）。
关键接缝已核对：`streamProxy`（服务端持密钥的转发协议，正合企业网关）、
`beforeToolCall`/`afterToolCall`（审批、审计、路径守卫可原样挂载）、
`transformContext`/`convertToLlm`（压缩与 UI-only 消息）、`openNodeSqliteStorage`（会话落库）。

## 决策

1. **进程内嵌入 pi 的库，不做子进程 CLI 转发**。子进程方式（`pi` 的 rpc 模式）无法在进程内拦截工具调用，
   审批/审计/沙箱会失效（企业合规红线）。桌面壳、管理台、服务端仍是我们自己的产品层。
2. **采纳矩阵**：

| pi 包 | 采纳 | 替换/新增 | 引入阶段 |
| --- | --- | --- | --- |
| `pi-ai` 1.2.0 | ✅ | 替换自研 provider（openai chat / openai-responses / anthropic-messages 均在其目录内） | P1 |
| `pi-agent-core` 1.2.0 | ✅ | 替换自研 `agent/loop.ts`（循环、并行工具、取消、引导） | P2 |
| `pi-durable` 1.2.0 + `chord` 1.2.0 | ✅ | 替换自研会话存储（写先于展示 = 崩溃恢复、任务图） | P3 |
| `pi-mcp` 1.2.0 | ✅ | 替换自研 MCP stdio 客户端 | P4 |
| `pi-codemode` 1.2.0 | ✅ | 新增：模型写 JS 调工具（QuickJS WASM 沙箱），默认关闭、走审批 | P4 |
| `pi-env` 1.2.0 | ✅ | 新增：工具在远端执行（SSH daemon），企业场景可选启用 | P5 |
| `pi-telemetry` 1.2.0 | ✅ | 新增：仅取契约与 noop 实现 | P1 |
| `pi-evals` | ❌ | 未发布到 npm（内部包）；评估需求用我们自己的测试与 `scripts/benchmark.py` 承担 | — |
| `pi-tui` | ❌ | 终端 UI 与 Electron 壳无对应需求；如未来需要 CLI 运维界面再议 | — |
| `pi-coding-agent` | ❌（仅参考） | 它是 CLI 应用层，与客户端/管理台重叠；其依赖的库已全量采纳 | — |

3. **治理能力仍归 hu-agent**：权限判定、路径守卫、审批（broker）、审计落盘、用量上报、服务端下架/
   停用校验，全部挂在 pi 的 `beforeToolCall`/`afterToolCall`/事件订阅上。换引擎不降低治理强度。
4. **信任边界（新增企业网关模式）**：企业部署下密钥只存服务端，客户端通过实现 pi 的 `streamProxy`
   协议取流；个人模式保持 ADR-0002（密钥在客户端 safeStorage）。两种模式并存，由配置决定。
5. **许可与合规**：pi 全为 MIT；引入的包在 `NOTICE` 中声明并保留 MIT 文本。**`pi-telemetry` 已审计**：
   596 行、纯契约与内存/noop 实现，无 `fetch`、无 URL、无环境变量读取、不发送任何数据；我们仍显式注入
   noop 实现，确保不外发。
6. **依赖策略**：版本**精确 pin**（不用 `^`）；只按需 import provider 子路径；打包时排除未使用的
   SDK（`@aws-sdk/*`、`@google/genai`）；上游升级必须先过事件协议契约测试。ADR 0006 是唯一允许
   Agent 相关第三方依赖的入口，替代品评估需新开 ADR。
7. **分阶段实施，每阶段可回滚**：P0 合规基线 → P1 模型层 → P2 循环层 → P3 会话持久化 → P4 MCP 与
   Code Mode → P5 远程执行 → P6 打包与文档收尾。每阶段带 feature flag（如 `model.engine`、
   `agent.engine`、`session.store`），出问题可切回自研实现，删除自研代码放在该阶段稳定之后。

## 后果与待办

- **体积**：核心包解包约 10 MB（`pi-ai` 4.2 MB、`pi-durable` 3.2 MB、`chord` 1.5 MB…），另有 `pi-ai`
  的传递依赖（`openai`、`@anthropic-ai/sdk`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`）。
  `pi-env` 18 MB（含 Rust daemon）只在 P5 且作为可选特性。需要在 P6 做打包排除与体积复核。
- **上游风险**：`pi-durable` 自述 Experimental（API 不通知地变更）。缓解：存储适配层薄化、版本精确 pin、
  迁移脚本 + 回滚开关；若上游破坏性变更影响生产，回落到 P3 之前的自研存储。
- **迁移成本**：会话数据需从现有 items 迁到 durable entries（P3 提供一次性迁移脚本 + 双读校验）。
- **文档同步**：`design.md` 客户端架构章节、`plan.md` 阶段条目在 **P1–P5 各阶段落地时与代码同提交**
  改写（附录 F）；`docs/optimization.md` 记录计划与进度；新增 `NOTICE` 与第三方许可清单（P6）。
