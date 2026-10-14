# 代码优化方向（v1.x 提案）

状态：**待决策**（本文是讨论稿；决策落定后转为 ADR-0006/0007 与 plan.md 的 v1.x 阶段条目）
范围：Agent 引擎（交给 pi）、UI 体系（样式与动效）、可观测性一键部署。
纪律：任何结论变更都在同一提交内更新本文件与 `docs/`（design.md / plan.md / ADR）。

---

## 0. 现状盘点（事实，非判断）

| 维度 | 现状 |
| --- | --- |
| 自研 Agent 层 | `app/src/main/{agent,model,tools,session,permissions}` 共约 3k 行（Agent 循环 + 三种 API 类型 provider + 压缩 + 工具 + 会话 + 权限） |
| 模型层 | 自研 provider：`openai`（chat）、`openai-responses`、`anthropic`，SSE 解析自实现；密钥存客户端 safeStorage（ADR-0002） |
| 权限/审批/审计 | 自研：路径守卫、broker 审批、audit 落盘（`permissions/*`），是产品差异化能力 |
| UI 样式 | Tailwind v4，524 处工具类；`index.css` 仅 72 行，**0 个设计令牌、0 处过渡/动画、无深色主题** |
| UI 代码量 | App + 20 个组件共 1330 行；无第三方 UI 库（React 19 + react-markdown） |
| pi（参考源码 `C:\Users\chen\Dev\pi`，MIT） | `pi-agent-core` 6.8k 行（Agent 循环/事件流/工具/传输抽象）、`pi-ai` 75k 行（多 provider + 模型目录）、`pi-mcp`、`pi-codemode`、`pi-durable`、`pi-tui` |

---

## 1. 轨道 A：Agent 引擎交给 pi

### 1.1 pi 暴露的接缝（与我们的能力对应关系）

| pi 接缝 | 位置 | 对我们意味着什么 |
| --- | --- | --- |
| `Agent` / `agentLoop` | `pi-agent-core` | 替换我们自研的 `agent/loop.ts`（turn 调度、并行工具执行、终止条件） |
| `streamFn` + `models.streamSimple` | `pi-ai` | 替换自研 provider（openai chat / openai-responses / anthropic 均在 pi 的 provider 列表内，另含 deepseek 等） |
| `streamProxy(model, context, {proxyUrl, authToken})` | `pi-agent-core/proxy.ts`（393 行，协议已定义） | **企业网关模式**：由服务端持密钥并转发，客户端只发协议事件流；取代"每台客户端存密钥"的模式 |
| `beforeToolCall` / `afterToolCall` | `pi-agent-core` | **我们保留治理层的关键缝隙**：审批（broker）、审计、path-guard、`enabled = intent ∧ server state` 都在这里 |
| `AgentTool.execute` + `typebox` 参数 | `pi-agent-core` | 我们现有 read/write/edit/shell/ask-guide 工具改为薄适配（新增依赖 `typebox`，MIT，体积小） |
| `transformContext` | `pi-agent-core` | 上下文压缩（替换自研 `compaction.ts`） |
| `convertToLlm` + 自定义消息类型（declaration merging） | `pi-agent-core` | UI-only 消息（引导卡、工具卡、审批卡）作为自定义 role 保留，不必塞进 LLM 上下文 |
| `prepareRequest` / `finishTurn` | `pi-agent-core` | 会话持久化与"轮次上限/停止策略"的挂载点 |
| 事件流（`message_start/update/end`、`tool_execution_*`） | `pi-agent-core` | 与我们 `app/src/shared/events.ts` 渲染事件近乎一一对应，需写映射层 + 契约测试 |
| `pi-mcp` | 独立包 | 替换自研 MCP stdio 客户端（`app/src/main/mcp/*`） |
| `pi-codemode` | 独立包 | 新增能力：模型写 JS 调用工具（企业场景需评估沙箱与审计） |
| `pi-durable` | 独立包 | 可替换自研会话存储（63k 行，能力更强，但耦合更深） |

### 1.2 决策（已采纳）：全量采用 pi 组件

用户决策：**使用 pi 提供的所有组件**。采纳矩阵、许可与合规（`pi-telemetry` 审计结论：596 行纯契约、
无 `fetch`/URL/环境变量读取、我们显式注入 noop）、依赖策略（精确 pin、provider 子路径按需引入、
打包排除未用 SDK）与信任边界（企业模式走服务端 `streamProxy`；个人模式保持 ADR-0002 本地密钥）
均记录在 [`docs/adr/0006-pi-agent-engine.md`](adr/0006-pi-agent-engine.md)。

**不设运行时引擎开关**（决策 2：全面转向 pi）：每阶段内部先接好 pi、测试全绿，再在同一提交里删除自研代码，
阶段提交本身即回滚点。

采用方式：`pi-coding-agent` **仅作库**（其 provider 配置与模型注册实现：`models.json` 格式、`ModelRegistry`、
`getAgentDir()`），不发布它的 CLI/TUI；`pi-tui` 只作为它的依赖被装入，界面不采用；
`pi-evals` 未发布到 npm，职责由我们的测试与 `scripts/benchmark.py` 承担。

**provider 配置**（含企业网关）沿用 pi 的 `models.json`，加载优先用 `pi-coding-agent` 的 `ModelRegistry`，
体积不可接受时退化为 ~60 行薄适配（同一格式，可互换）；企业模式密钥仍在服务端（`streamProxy`）。

### 1.3 重组后的实施计划（每阶段可独立验证、可回滚）

| 阶段 | 内容 | 依赖（精确 pin） | 出口标准 |
| --- | --- | --- | --- |
| **P0 合规基线** ✅ | 遥测审计、许可与依赖策略、ADR-0006、npm 可用性核对 | — | 已完成（`pi-evals` 404 已确认） |
| **P1 引擎切换**（模型层 + 循环层合并）🚧 | ① **P1.1 配置层 ✅**：`pi-config.ts` 读 pi 的 `models.json`（薄适配，不用 `ModelRegistry`；见 ADR 决策 8 的实测理由）② **P1.2**：用 `pi-agent-core` 的 `Agent` 替换 `agent/loop.ts` + 自研 provider/SSE，权限/审批/审计挂 `beforeToolCall`/`afterToolCall`，`transformContext` 接压缩，事件映射 + 契约测试 | `pi-ai@1.2.0`、`pi-agent-core@1.2.0`、`pi-telemetry@1.2.0`、`typebox@1.3.27` | ① 已完成：6 条配置层测试 + typecheck 全绿 ② 待完成：faux 契约测试（文本/工具/用量/阻断）+ 4 个 e2e 门禁 + 真实调用（`pi-real`）+ **自研 provider/SSE/循环代码删除** + main 包体积增量复核 |
| **P3 会话持久化** | `pi-durable` + `chord` 接管会话/任务（`openNodeSqliteStorage`，写先于展示 = 崩溃恢复）；旧 items 迁移脚本 + 双读校验 | `pi-durable@1.2.0`、`chord@1.2.0` | 杀进程后重开续跑；迁移双读校验；快照/同步/审计语义不回退 |
| **P4 MCP 与 Code Mode** | `pi-mcp` 替自研 MCP；`pi-codemode` 可选（WASM 沙箱 + 审批，默认关） | `pi-mcp@1.2.0`、`pi-codemode@1.2.0` | MCP e2e 全绿；越权用例被审批/沙箱拦下 |
| **P5 远程执行** | `pi-env`（SSH daemon）作为企业可选能力：主机指纹校验 + 密钥管理 | `pi-env@1.2.0`（18 MB，含 Rust daemon） | 远端工作区跑通一个工具回合 + 审计就位 |
| **P6 打包收尾** | 排除未用 SDK（`@aws-sdk/*`、`@google/genai`）、`NOTICE`、体积复核、删自研代码 | — | 安装包体积可接受；安全扫描 0 漏洞 |

轨道 B（UI 令牌 + 动效）不依赖 P1–P5，可与引擎切换并行；轨道 C 已落地。

### 1.5 P1.2-c 蓝图：用 pi 的 `Agent` 替换旧循环

读完旧循环（388 行）后，它的对外行为可归为 **8 项职责**。逐一给出 pi 的落点，避免"用旧网关写一遍新循环"：

| # | 旧循环职责（必须保持） | pi 的落点 |
| --- | --- | --- |
| 1 | 追加用户消息、`touch` 会话、发 `turn.start` | 循环外层（`prepareRequest` 之前） |
| 2 | 组装 system prompt（工作空间 + Skill 段） | `initialState.systemPrompt` / system 消息 |
| 3 | 上下文超阈值压缩（`COMPACT_THRESHOLD`、`session.compacted`、失败降级为保留最近 N 条） | `transformContext`（回调内调用现有压缩能力）+ 由循环发 `session.compacted` |
| 4 | 流式文本/思考增量、工具调用收集 | pi 事件 → `pi-events.ts` 映射（已完成） |
| 5 | 权限/审批/拒绝语义（敏感路径、保护文件、ask 等审批） | `beforeToolCall` + `afterToolCall`（已完成，含拒绝状态补标） |
| 6 | 工具执行语义（截断、产物落盘、status 分类、`tool_call`/`tool_result` 双写会话） | `createAgentTools` 负责执行与 details；会话双写由循环在 `tool_execution_start/end` 上做 |
| 7 | 用量三写：`sessions.append(usage)` + `ledger.record` + `telemetry.record`（含失败路径的 0 用量与 errorCode） | `message_end` 的 `usage`（映射已完成）→ 循环写三处；失败路径用 `agent_end` 后的错误处理 |
| 8 | 停止原因：无工具调用即结束、`length` → `OUTPUT_TRUNCATED` 错误项、步数上限 → `max_steps` + `MAX_STEPS` 错误项、取消 → `cancelled`、异常 → `TURN_FAILED` | `finishTurn` 返回 `{ action: 'end' }` 控制步数；循环据信号与异常决定 `turn.end` 的 stopReason |

**前置设计决定（本文件记录，避免返工）**：新循环**不依赖 `ModelGateway`**，而是依赖两个能力接口，
由 P1.2-d 用 pi 实现、测试里用假实现：

```ts
interface ModelResolver {
  resolve(target?: string): Promise<{ providerId: string; modelId: string; contextWindow: number; model: PiModel }>
}
interface HistorySummarizer {
  summarize(messages: LlmMessage[], signal: AbortSignal): Promise<string>   // 供压缩使用
}
```

理由：`compaction.ts` 现在是照 `ModelGateway.chat()` 写的；若新循环继续用它，P1.2-d 就删不掉网关。
改成能力接口后，网关与旧 provider 可在 d 批一次性删除，压缩改为调用 `HistorySummarizer`
（由 pi 的一次非流式调用实现）。

### 1.4 P1 进度

已完成：依赖安装（精确 1.2.0；`pi-ai` 5.9 MB + `pi-agent-core` 319 KB + `pi-telemetry` 175 KB，传递依赖
约 60 MB 待 P6 排除）；`app/tests/pi-engine.test.ts` 5 条零网络冒烟（模型目录、完整回合、工具结果回灌、
`beforeToolCall` 阻断、三种 API 类型目录覆盖）；全量客户端测试 195 passed / 13 skipped；
`npm audit --omit=dev` 0 漏洞。

真实调用（P1 关键验证，`app/tests/integration/pi-real.test.ts`，门禁 `PI_E2E=1`）：经企业 OpenAI 兼容网关
（自定义 provider，`openai-completions`，按请求注入密钥）跑通**流式文本**与**完整 Agent 回合**
（真实模型 + 工具执行 + 用量回传）两条用例 ✓。踩坑记录（已写入测试注释，P1 实现必须遵守）：

1. `createProvider({ models })` 里的模型必须是**完整 Model 对象**（含 `api`/`provider`/`baseUrl`），
   否则报 `Unknown provider: undefined`；
2. `auth` 的形状是 `{ apiKey: ApiKeyAuth }`，直接传 ApiKeyAuth 本体会报 `Provider is not configured`；
3. 密钥按请求注入（`streamSimple(model, ctx, { apiKey })`），不注册进 pi 的凭证存储——与
   「企业模式密钥在服务端 / 个人模式在 safeStorage」的设计一致。

待办（P1.2 引擎切换，一次性切换不留 legacy）：以 `Agent` 替换 `agent/loop.ts` 与
`model/providers/*` + `model/gateway.ts` 的 SSE 适配；用量从 pi 事件映射进 usage ledger；
模型目录接入设置页；删除自研 provider/SSE/循环代码；复核 main 包体积增量。

**P1.1 已完成**（配置层，独立可验证）：`app/src/main/model/pi-config.ts` + `app/tests/pi-config.test.ts`
6 条测试（字段映射、密钥优先级与"密钥不落盘"、缺文件容错、与 pi CLI 配置互通），`npm run typecheck` 全绿。

式与动效体系，且**不引入第三方 UI 库**（保持零依赖与包体）。

### 2.1 B1 设计令牌层（Tailwind v4 `@theme`，零依赖）

新增 `app/src/renderer/src/styles/tokens.css`，用 Tailwind v4 的 CSS-first 配置：

- 色板：品牌主色（含 50–900 梯度）、中性灰阶、语义色（success / warning / danger / info）、表面与边框层级（surface-1/2/3、border-subtle/strong）
- 尺度：间距（4 基准，0–16 阶）、圆角（sm/md/lg/full）、字号与行高（含中英混排基线：`system-ui` + `Microsoft YaHei`/`PingFang SC`，数字用等宽变体）、阴影（3 级）、z-index 分层
- 动效令牌：时长（`instant 100ms` / `fast 160ms` / `base 240ms` / `slow 400ms`）、缓动（`standard` / `decelerate`(进场) / `accelerate`(退场) / `emphasized`）
- 主题：浅色/深色双套（`class="dark"` 策略 + `prefers-color-scheme` 默认），令牌是唯一色值来源；「跟随系统 / 浅色 / 深色」进设置
- 纪律：**禁止组件内出现硬编码色值/时长**，由 `app/scripts/ui-check.mjs` 校验并纳入 `npm run check`

### 2.2 B2 动效系统（CSS-only，尊重 `prefers-reduced-motion`）

- 只动 `transform` / `opacity`（GPU 友好）；不动布局属性；单次动效 ≤ 400ms；同一时刻最多一个"主"动效
- 场景清单（首批）：
  1. 消息流：新消息进场（`decelerate` 上浮 + 淡入）、流式文本光标呼吸、Markdown 代码块淡入
  2. 工具卡：状态切换（运行中 → 成功/失败）用高度与色彩过渡，失败用一次性 shake（≤ 200ms）
  3. 审批卡：进场强调（`emphasized` 缓动 + 轻微缩放），决定后收起
  4. 侧栏/标签页：切换用短淡入 + 位移（≤ 160ms），避免长过渡拖慢操作
  5. 列表：首屏 stagger（每项延迟 ≤ 20ms，总数 ≤ 8 项参与，避免"排队长龙"）
  6. 弹层（Dialog/Drawer）：240ms 进出 + 遮罩淡入；`Esc` 与焦点回退
  7. 加载：骨架屏（shimmer 用令牌灰度）+ 按钮内联 spinner
  8. 空态：首次进入的轻量引导动效（一次性，不循环）
- 无障碍：`prefers-reduced-motion: reduce` 时全部降级为瞬时切换；焦点环始终可见（企业合规）

### 2.3 B3 组件原语（`app/src/renderer/src/components/ui/*`）

约 12–15 个：`Button`、`IconButton`、`Input`、`Textarea`、`Select`、`Card`、`Badge`、`Tooltip`、`Dialog`、`Drawer`、`Toast`、`Skeleton`、`EmptyState`、`Segmented`、`Spinner`。
约定：`variant`（primary/secondary/ghost/danger）× `size`（sm/md/lg）两个维度，令牌驱动；键盘与 ARIA 基线（Tab 顺序、`aria-live` 用于审批与错误、44×44 触控区）。

### 2.4 B4 组件画廊（不引 Storybook）

dev-only 路由 `/gallery`（生产构建剔除）：令牌可视化（色板/尺度/动效时长可点播）+ 每个原语的各状态。作为设计与评审的单一事实来源，同时充当视觉回归的手动检查页。

### 2.5 迁移策略

先立令牌与动效基建 → 新建页面按新体系写 → 旧组件**按页面逐个迁移**（登录门禁 → 对话页 → 设置页 5 个 section → 其余），每页迁移后跑一次客户端测试与截图自查。

### 2.6 决策点（需你确认）

- **D-5 主题**：是否需要深色主题（工作量 +30%，令牌层已预留）？建议要（开发者群体刚需）。
- **D-6 动效风格**：**克制**（企业工具，推荐：信息密度优先，动效只用于状态变化与空间关系）还是更活泼（更多弹性/装饰性动画）？
- **D-7 依赖**：坚持零依赖手写原语（推荐，包体与可控性最好），还是引入现成 UI 库（antd/radix，开发快但与现有 524 处工具类风格割裂、包体 +数百 KB）？

---

## 3. 轨道 C：可观测性一键部署（✅ 已落地，见 docs/delivery/monitoring.md 第 7 节）

目标：中小企业 `docker compose` 一键起一套完整监控，配合既有 `/api/v1/system/metrics` 与 12 条告警规则。

- `docker/compose.observability.yaml`（叠加层，独立卷与网络，可单独 `up/down`）
  - **Prometheus**（抓取 API + 自身；规则文件即 `docs/delivery/monitoring.md` 的 12 条，转为 `rules/huagent.yml`；保留期可配）
  - **Grafana**（预置数据源 + 3 个 dashboard JSON：API 黄金指标 / 依赖与作业新鲜度 / 认证与 SSO；可选匿名只读 + 环境变量指定管理员口令）
  - **Alertmanager**（邮件与通用 webhook 两条路由；邮件参数复用现有 SMTP 配置）
  - **可选 Loki + Promtail**（容器与应用日志聚合，日志按 30 天保留）
- 接入：`scripts/quickstart.sh monitoring up|down|status`；`HUAGENT_METRICS_TOKEN` 自动写入 `.env.quickstart` 并被 Prometheus 使用
- 文档：`docs/delivery/monitoring.md` 增补「一键部署（中小企业）」章节；`docs/delivery/deployment.md` 增补叠加层说明
- 验证：起栈后 curl 三个组件健康端点 + Grafana 数据源连通 + 触发一条告警规则（如人为停 API，验证 `HugagentAPIDown` fire → Alertmanager 收到）

### 决策点

- **D-8 是否需要 Loki 日志聚合**（+1 组件约 200MB 内存；不需要则只留指标与告警）
- **D-9 告警通知渠道**：仅邮件（SMTP 已有配置）还是同时给 webhook（企业 IM 自接）？建议两者都要

---

## 4. 轨道 D：v1.x 功能议题（待逐个讨论）

管理台用户管理页（列表/禁用/重置密码）、邀请撤销、统计成员下钻、MCP 市场（5-08）、MCP http/sse（3-05）、邮件通道、用量配额与限额。

---

## 5. 建议执行顺序

1. **P1 模型层**（进行中）：切 provider + 用量取数 + 契约测试
2. **P2 循环层**：换 `Agent`，治理挂钩子（企业能力不回退是硬门槛）
3. **B1 + B2**（可并行）：设计令牌 + 动效系统，零依赖
4. **P3 会话持久化** → **P4 MCP/Code Mode** → **P5 远程执行** → **P6 打包收尾**
5. 轨道 D（v1.x 功能议题）与 P2/P3 之后逐个议
