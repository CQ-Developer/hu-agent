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
| **P1 引擎重构（pi 为核）** ✅ | **不做形状适配**：会话/消息/工具/模型全部改用 pi 原生（`Agent`+`pi-durable`+`AgentTool`+`pi-ai`），旧的 `LlmMessage`/事件联合/工具接口/会话存储/自研 provider/MCP 一律删除；我们的代码只保留企业侧能力（权限/审批/审计/用量/同步/市场/服务端）与 IPC 边界投影 | `pi-ai`、`pi-agent-core`、`pi-durable`+`chord`、`pi-mcp`、`pi-codemode`、`pi-telemetry`、`typebox`（精确 pin） | ① 定向测试全绿 ② 旧模块删除且 import 图干净 ③ e2e + 真实调用 ④ main 包体积复核 ⑤ `design.md` 按 pi 为核心改写——均已达成（R1–R6）；发行包排除与体积终审见 P6 |
| **P6 打包与文档收尾** ✅ | 依赖瘦身（移除 `pi-coding-agent`/`pi-telemetry` 直依、renderer 依赖入 dev）+ electron-builder 排除（google/bedrock 链 + `.map`/`.d.ts`/源码目录）+ **主进程 ESM 化**（修复启动级缺陷）+ `NOTICE` + 构建产物冒烟入 CI | — | `app.asar` 105 MB → **16 MB**；`win-unpacked` 477 MB → **385 MB**；打包形态实测可启动；见 ADR-0007 |

轨道 B（UI 令牌 + 动效）不依赖 P1–P5，可与引擎切换并行；轨道 C 已落地。

### 1.5 P1.2-c 蓝图：用 pi 的 `Agent` 替换旧循环

> ⚠️ 本节是当时的实现蓝图（历史记录）。最终落地为 pi-durable 的 `submit` + 扩展钩子，
> 见 1.6 的 R1 与 ADR-0006「不使用门面」修订。

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

> **R1 前置验证（spike）✅**：`tests/pi_durable_spike.test.ts` 用 SQLite 存储 + faux provider 实测四件事——
> ① 关掉存储再重开，会话仍在（单文件落盘）；② **`requestId` 跨重启幂等**（重开后再提交同一 id 得到同一
> submission，不重复生成）——这正是同步/重试需要的保证；③ `harness.resume()` 可继续上次未完成的运行
> 且不阻塞；④ `harness.submission(id)` 重开后可取回历史。据此认为 pi-durable 虽自标 Experimental，
> 但其**存储与提交语义足以承载我们的会话**。

> **R1 完成 ✅**：① 会话服务（`session/durable.ts`，直接使用 pi-durable，无门面）✅
> ② 集成方式已实测：回合由 harness 跑，工具与治理以**扩展 + `beforeTool`/`afterTool` 钩子**接入
> （异步钩子受支持；真实模型下已验证“钩子阻断 → 工具体不执行”，
> 用例 `tests/integration/pi_durable_hooks_real.test.ts`）✅
> ③ 回合改写为 submit + 订阅 `viewState`（`agent/durable_loop.ts` / `agent/durable_runner.ts`）✅
> ④ IPC/index 切到会话服务（`sessions:*` → `DurableSessions`，实时事件由 `agent/durable_projection.ts` 投影）✅
> ⑤ 旧会话路径已删除（`session/{store,items,types,stats}.ts`、`agent/{pi_loop,pi_events,pi_runner,events}.ts`）✅
> 旧本地 JSONL 会话按计划**归档为只读**（导入脚本可后补）。
> 后续：**R5/R6/P6 均已完成**（见下表与 1.6 进度）；引擎轨道收尾，剩 v1.x 功能与交付清单。

### 1.6 修订后的重构步骤（pi 为核）

> **R3/R4 收尾 ✅**：运行器装配 · 模型设置来源桥（`config/pi_model_settings.ts`）· IPC/index 切换 ·
> MCP 换 `@earendil-works/pi-mcp`（`mcp/manager.ts`，过渡桥 `tools/mcp_bridge.ts` 已删）。
> 旧 `ModelGateway` / `ToolRegistry` / `SettingsStore` 已随 R5 删除；回合生命周期最终由 pi-durable 承担（R1）。

> **R6 完成 ✅**：IPC 事件收敛为 pi 事件的机械投影（去掉不再产生的 `max_steps` 与
> `session.compacted`）；`design.md` 的 5.1/5.2/5.4/5.8/5.9 按实际实现重写；旧实现引用
> （plan/signing/ADR-0003）同步修正。命名：客户端代码文件已全部下划线（e913695）；
> ADR 编号、docker/CI/脚本等**非代码文件名**沿用各自生态惯例，不再重命名。

> **P6 打包与文档收尾 ✅**：发行包瘦身 + 启动级缺陷修复。
> ① 依赖瘦身：移除未被引用的 `pi-coding-agent`（31 MB）与 `pi-telemetry` 直依；`pi-mcp` 转显式；
> renderer 依赖（react 等，构建时已打包）入 devDependencies。
> ② electron-builder 排除：pi-ai 的 google/bedrock 可选 SDK 链（按 lockfile 依赖图精确算出的 48 个包）
> 与 `*.map`/`*.d.ts`/源码目录；发行 `app.asar` 105 MB → **16 MB**、`win-unpacked` 477 MB → **385 MB**。
> ③ **修复启动级缺陷**：主进程改产出 ESM（`out/main/index.mjs`）——pi 包是 ESM-only，CJS `require`
> 直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`（单测不加载构建产物，所以一直没暴露）；新增
> `app/scripts/check_main_esm.mjs` 冒烟并接入 CI。④ 根目录 `NOTICE` 与许可清单建立。
> 决策与排除清单见 `docs/adr/0007-esm-main-and-packaging.md`。

> 命名约定（本轮新增）：新文件一律用**下划线**（`read_file.ts` / `pi_governance.ts`），与 Python 侧一致；
> 客户端的 kebab-case 属遗留，随文件被改动时一并改名。约定已记入 `CONTRIBUTING.md`。


| 步 | 内容 | 出口标准 |
| --- | --- | --- |
| **R1** ✅ | **直接使用 `pi-durable`（无门面）**：① 回合改为 `root.submit` + 订阅 `viewState` 投影到 IPC 事件；② 会话选项改为 `root.configure`（模型/thinkingLevel/cwd/tools/instructions）；③ 用量改从 `docs["pi.usage"]`/`harness.usage()` 读入我们的 ledger 与上报；④ 旧本地 JSONL 会话归档为只读（导入脚本可后补）；⑤ 删除旧会话路径（`session/{store,items,types,stats}.ts`、`agent/{pi_loop,pi_events,pi_runner,events}.ts`） | `pi-durable@1.2.0`、`chord@1.2.0` | ① 崩溃恢复演练：杀进程重开续跑同一回合 ② 用量落账与 pi 的 usage 一致 ③ 界面（会话列表/消息/工具卡/用量）无回退 ④ 旧会话归档为只读（不阻塞新路径） |
| R2 ✅ | 工具换 `AgentTool`（typebox 参数），删除 JSON Schema 工具接口与自研注册表。6 个内置工具全为 pi 原生（`tools/native/*`，自 `0d6c394` 起），`pi_governance.ts` 只保留 `createDefaultTools`；治理行为由 `durable_loop` 的扩展钩子承担 | 6 个内置工具等价行为 + 治理钩子测试 |
| R3 ✅ | 回合生命周期交给 pi-durable harness（`agent/durable_loop.ts` + `agent/durable_runner.ts`）；旧 `pi_loop.ts`/`pi_runner.ts` 与复刻的 8 项职责代码已删（R1 最后一批） | e2e 与真实调用通过时无行为回退 |
| R4 ✅ | MCP 换 `pi-mcp`（stdio；`mcp/manager.ts`）；`pi-codemode` 未接入，留 v1.x 可选 | MCP e2e 通过；越权用例被审批拦下 |
| R5 ✅ | 删除遗留：旧 provider/gateway/loop/compaction/会话存储早已删（`0d6c394` + R1）；本批清掉死类型（`LlmMessage`/`ToolCall`/`TokenUsage` 等 9 个）与旧 `SettingsStore` 及其测试。artifacts 决策：保留我们的 `session/artifacts.ts`，不并入 pi-durable（它没有大文本/blob 存储） | `rg` 无残留 import；全量守卫绿 |
| R6 ✅ | IPC 事件收敛为「pi 事件的机械投影」（删除不再产生的 `max_steps` 与 `session.compacted`）；`design.md` 旧章节（5.1/5.2/5.4/5.8/5.9）按 pi 为核重写；客户端代码文件名已统一为下划线（`e913695`，48 个文件）。命名决定：非代码文件名沿用各自生态惯例（ADR 编号、docker 配置、CI/脚本、electron-builder 配置），不再重命名 | 渲染层契约无第二套语义 + 客户端无 kebab-case 代码文件 |

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

已完成（历史待办，见 1.6 R1–R6）：`agent/loop.ts`、`model/providers/*` + `model/gateway.ts` 均已删除；
模型目录接入设置页；用量改从 pi 的 `pi.usage` 汇入 ledger/上报。main 包体积已复核（见 1.6，P1 ✅）。

**P1.1 已完成**（配置层，独立可验证）：`app/src/main/model/pi-config.ts` + `app/tests/pi-config.test.ts`
6 条测试（字段映射、密钥优先级与"密钥不落盘"、缺文件容错、与 pi CLI 配置互通），`npm run typecheck` 全绿。

## 2. 轨道 B：客户端 UI 体系（设计令牌 + 动效 + 原语）

目标：为客户端建立一套可演进的设计语言（表面层级、字阶、动效），且**不引入第三方 UI 库**（保持零依赖与包体）。

### 2.0 决策记录（2026-10-15，用户确认）

| 决策点 | 结论 |
| --- | --- |
| 视觉方向 | **元素级液态玻璃**（参考 `液态玻璃设计.html`，2026-10-15 用户澄清）：按钮/输入/卡片/弹层/分段控件/开关/滑杆等元素用「半透明 + backdrop-blur + 镜面描边 + 悬浮阴影」；页面保持中性背景（不做满屏彩色光斑舞台） |
| D-5 主题 | **做**：浅色 + 深色，跟随系统 + 手动切换；`class="dark"` 策略 + `prefers-color-scheme` |
| D-6 动效 | **更活泼**：过冲/回弹（spring / bounce）、按钮磁吸、点击涟漪、指针跟随高光；单次 ≤ 600ms；`prefers-reduced-motion` 全量降级 |
| D-7 依赖 | **零依赖**手写元素（不引 radix / shadcn / antd） |
| 导航结构 | 顶部只保留「对话 / 市场」+ 齿轮设置面；其余入口收进「设置」（分组：工作区 / 团队与云 / 系统）——**已实施**（2026-10-15，`components/SettingsDialog.tsx`） |
| 平台 | Windows 与 macOS 同等 |
| 强调色 | 单一品牌强调色：浅色 `#5563e8` / 深色 `#7e9aff`（取自参考稿的主按钮与开关） |

**落地状态（2026-10-15）**：元素级玻璃已落到客户端：`app/src/renderer/src/styles/tokens.css`（双主题令牌 +
元素组件类 `.glass` / `.ui-btn*` / `.ui-field` / `.ui-segmented` / `.ui-switch` / `.ui-slider`）、
`app/src/renderer/src/components/ui/glass.tsx`（指针跟随高光 / 磁吸按钮 / 点击涟漪）；壳层、对话页、
登录门禁与设置页已迁移；**management-ui 已迁移**（`app/theme.ts` 主题偏好 + ConfigProvider 算法与主色 +
`index.css` 覆盖 antd 组件为玻璃表面，头部/登录页提供 跟随系统/浅色/深色 切换）；dev-only 设计画廊同步。
**导航重构已实施**：顶部只保留「对话 / 市场」，模型/Skill/MCP/工作空间/云同步/用量/权限/关于收进设置弹层
（分组：工作区 / 团队与云 / 系统）。页面底色为中性浅灰渐变（无彩色光斑），元素无鼠标跟随光环，
按钮不做磁吸位移（悬停移位会导致点击丢失）。
画廊入口：`HUAGENT_RENDERER_PORT=5179 npx electron-vite dev --rendererOnly` 后访问 `/gallery.html`；
主应用用 `@source not './gallery'` 排除画廊类名，画廊用独立的 `gallery.css` 入口。

### 2.1 B1 设计令牌层（Tailwind v4 `@theme`，零依赖）

新增 `app/src/renderer/src/styles/tokens.css`，用 Tailwind v4 的 CSS-first 配置：

- 色板：品牌主色（含 50–900 梯度）、中性灰阶、语义色（success / warning / danger / info）、表面与边框层级（surface-1/2/3、border-subtle/strong）
- 尺度：间距（4 基准，0–16 阶）、圆角（sm/md/lg/full）、字号与行高（含中英混排基线：`system-ui` + `Microsoft YaHei`/`PingFang SC`，数字用等宽变体）、阴影（3 级）、z-index 分层
- 动效令牌：时长（`instant 90ms` / `fast 170ms` / `base 260ms` / `slow 420ms` / `lazy 600ms`）、缓动（`standard` / `decelerate`(进场) / `accelerate`(退场) / `spring`(过冲) / `bounce`(回弹)）
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

### 2.6 评审入口与剩余待定

- 决策已确认（见 2.0）；剩余待评审：**强调色定稿**（陶土 / 苔绿 / 墨蓝）与画廊视觉走查（浅/深双主题截图见 PR）。
- 后续按 2.5 迁移：登录门禁 → 壳层（导航重构：仅保留「市场」+ 设置面）→ 对话页 → 设置各区 → 空态/加载/错误态。

---

## 3. 轨道 C：可观测性一键部署（✅ 已落地，见 docs/delivery/monitoring.md 第 7 节）

目标：中小企业 `docker compose` 一键起一套完整监控，配合既有 `/api/v1/system/metrics` 与 12 条告警规则。

- `docker/compose.yaml` 的 `monitoring`/`logs` profile（与业务服务同一编排，可单独 `up/down`）
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

管理台用户管理页（列表/禁用/恢复/重置）与邀请撤销已于 2026-10-15 交付；剩余议题：统计成员维度下钻、邮件通道（自助忘记密码/邀请与审批结果投递）、用量配额与限额。
（MCP 市场 5-08 与 MCP http/sse 3-05 已于 2026-10-15 交付，不在 v1.x 议题内。）

---

## 5. 建议执行顺序

1. **P1 模型层**（进行中）：切 provider + 用量取数 + 契约测试
2. **P2 循环层**：换 `Agent`，治理挂钩子（企业能力不回退是硬门槛）
3. **B1 + B2**（可并行）：设计令牌 + 动效系统，零依赖
4. **P3 会话持久化** → **P4 MCP/Code Mode** → **P5 远程执行** → **P6 打包收尾**
5. 轨道 D（v1.x 功能议题）与 P2/P3 之后逐个议
