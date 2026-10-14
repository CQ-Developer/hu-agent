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

### 1.2 方案对比

| 方案 | 做法 | 优点 | 代价 | 结论 |
| --- | --- | --- | --- | --- |
| A1 只换模型层 | 用 `pi-ai` 的 provider/模型目录替换自研 `model/providers/*`，Agent 循环不动 | 风险最小、可当天验证；立刻获得模型目录与多 provider；保留全部治理代码路径 | 只解决 1/3 问题（循环与工具仍自研） | ✅ **第一步** |
| A2 引擎层替换 | 用 `pi-agent-core` 的 `Agent` 替换 `agent/loop.ts`，治理能力挂 hooks | 循环/并行/取消/引导/压缩交上游；我们专注治理与产品 | 需要事件映射层、工具适配层，回归面较大 | ✅ **第二步（分阶段开关）** |
| A3 进程内全量 | 直接嵌 `pi-coding-agent`（含 CLI 层） | 功能最全（会话、资源、扩展） | 引入 TUI/CLI/配置等与桌面壳重复的层，打包与行为不可控 | ❌ 不采用 |
| A4 子进程 | 以 `pi` CLI 的 **rpc 模式**（`rpc-entry.ts`）当引擎，JSON-RPC over stdio | 隔离好、几乎不写引擎代码；可跟上游快速同步 | 无法在进程内拦截工具调用 → **审批/审计/沙箱会失效**（企业合规红线）；跨平台启动、TLS 代理、事件粒度、装机体积都变差 | ❌ 不作为主路径；可留作"高级/兼容模式" |

**推荐：A1 → A2 分阶段，A3/A4 不采用。**

### 1.3 分阶段计划（每阶段独立可验证、可回滚）

1. **A1 模型层**（1 个提交，feature flag `model.engine = "pi-ai" | "legacy"`）
   - `pi-ai` provider 注册表 + `models.streamSimple` 作为 `streamFn`；保留我们的用量上报（从 pi 事件里取 usage）与错误码映射
   - 验证：三种 API 类型各跑一次真实调用 + 现有 `app/tests/*-provider*.test.ts` 全绿（provider 契约测试改为对 pi 层断言）
2. **A2 循环层**（治理不动，循环换）
   - `Agent` + `beforeToolCall`（审批/守卫/`enabled` 判定）+ `afterToolCall`（审计/结果改写）+ `transformContext`（压缩）
   - 事件映射：`pi event → app/src/shared/events.ts`，并为映射写契约测试（每个 pi 事件类型都有对应渲染事件）
   - 验证：`app/tests/{agent-loop,permissions-engine,compaction}.test.ts` 等价覆盖 + 4 个 e2e 门禁
3. **A3 外围替换**：`pi-mcp` 换自研 MCP；`pi-codemode` 作为可选能力（默认关闭，需评估沙箱）
4. **A4（可选）** 会话持久化迁移到 `pi-durable`——仅在 A2/A3 稳定后评估

### 1.4 决策点（需你确认）

- **D-1 密钥归属**：维持现状（客户端 safeStorage 存用户自己的 key，ADR-0002）还是新增**企业网关模式**（服务端持密钥 + 实现 `streamProxy` 协议，客户端不发密钥）？建议：**两者并存**——个人模式用本地 key，企业模式走网关；新增 ADR-0006 记录数据流与信任边界。
- **D-2 上游耦合**：`pi-*` 采用**精确版本 pin**（不用 `^`）+ 薄适配层（`app/src/main/agent/pi-adapter/*`），并加一条上游升级检查清单（含事件协议契约测试）。是否接受为 pi 新增 `typebox` 依赖（MIT，约 100KB）？
- **D-3 许可与归属**：pi 为 MIT（Copyright 2025 Mario Zechner）。嵌入后需在 `NOTICE`/`docs` 声明并保留 MIT 文本。是否接受？（Apache-2.0 项目包含 MIT 组件无冲突）
- **D-4 MCP 是否替换**：自研 MCP 客户端（stdio）换成 `pi-mcp`，还是保留自研（已通过 e2e 与安全校验）？

---

## 2. 轨道 B：UI 体系（页面样式 + 交互动画）

现状：Tailwind v4 + 524 处工具类，无令牌、无动效、无深色主题。目标是**一套可复用、可主题化、可校验**的样式与动效体系，且**不引入第三方 UI 库**（保持零依赖与包体）。

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

## 3. 轨道 C：可观测性一键部署

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

1. **轨道 C（监控栈）**：无需讨论即可开工，独立可验证 —— 我直接做
2. **轨道 B（UI 体系）**：等 D-5/D-6/D-7 决策后开工（B1+B2 基建 → 页面迁移）
3. **轨道 A（pi 集成）**：等 D-1…D-4 决策 → 先出 ADR-0006 → 从 A1 开始
4. 轨道 D 与 A/B 并行讨论，不阻塞
