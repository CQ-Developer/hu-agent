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
| `pi-tui` | ❌（界面不采用） | 终端 UI 与 Electron 壳无对应需求；它会作为 `pi-coding-agent` 的依赖被装入，但不暴露给用户 | — |
| `pi-coding-agent` | ✅（仅作库，不发布其 CLI/TUI） | 提供 provider 配置与模型注册的实现：`models.json` 格式、`ModelRegistry`、`getAgentDir()`、凭证存储 | P1 |

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
7. **P0 合规基线 → P1 引擎切换（模型层 + 循环层合并）→ P3 会话持久化 → P4 MCP 与 Code Mode →
   P5 远程执行 → P6 打包与文档收尾**。**不设运行时引擎开关**（用户决策：全面转向 pi）：每个阶段
   内部先接好 pi、测试全绿，再在同一提交里删除被替换的自研代码；阶段边界即回滚点（`git revert`）。
   只有与产品行为无关的开关才保留（如遥测实现、codemode 的启用位）。

   **为什么原 P1（模型层）与 P2（循环层）合并**：pi 的**工具声明属于 transcript**
   （见 `pi-ai` 的 `openai-completions` 实现：`transcriptTools.requestTools`，工具随 system 消息声明），
   而"单次流式 + 工具"需要自己拼装 transcript；`pi-agent-core` 的 `Agent` 正是管理 transcript、
   工具装载与事件流的组件。若强行只换模型层，就要在网关里自造工具声明注入，等于重复实现 Agent 的一半，
   随后还要在 P2 删掉。因此两阶段合并为一个"引擎切换"阶段，以 `Agent` 为集成点，
   **企业治理（权限/审批/审计）继续由我们挂在 `beforeToolCall`/`afterToolCall`**（faux 冒烟已证明可行）。

8. **provider 配置沿用 pi 的格式与实现**：自定义 provider（含企业 OpenAI 兼容网关）配置沿用 pi 的
   `models.json`（`providers.<id>.{api, baseUrl, apiKey, headers, models}`），因此**同一份配置在 pi CLI
   与我们客户端之间可直接互换**。加载路径按此优先级：
   1. ~~用 `pi-coding-agent` 的 `ModelRegistry` 读取~~ → **实测后不采用**：该包解包 31 MB，并会把
      `pi-tui`(2.8 MB)/`highlight.js`(2.8 MB)/`grok-mermaid`/`photon` 等 CLI 与界面依赖装进桌面应用，
      而我们只需要它的配置**格式与类型**；
   2. **采用薄适配**：`app/src/main/model/pi-config.ts` 读同一个 `models.json`（`ProviderModelConfig`
      仅作类型引入，运行时不加载该包），用 `pi-ai` 的 `createProvider` 构造。构造时补齐
      `api`/`provider`/`baseUrl` 三个字段——见 P1 踩坑记录（否则报 `Unknown provider: undefined`）。
   两条路径共享同一配置格式，将来若体积不是问题，把读取函数换成 `ModelRegistry` 即可，无格式迁移。
   配置目录默认为 `~/.hu-agent/agent`（`HUAGENT_AGENT_DIR` 可覆盖），不与 pi CLI 的 `~/.pi/agent` 互相打扰。
   密钥优先级：文件内 `apiKey`（兼容手工配置与 pi CLI 配置）> 本机密钥库（`model:<providerId>`，
   写回文件时不落盘）；企业模式两者都不用，密钥在服务端。
9. **企业模式不走本地文件存密钥**：`models.json` 里的 `apiKey` 仅用于个人模式与本机开发；企业部署下
   客户端不落密钥，由服务端持有并通过 `streamProxy` 供流（决策 4 的落地方式）。

## 修订（2026-10-14，用户决策）：以 pi 为核，不做形状适配

前一版把 pi 接成"我们的既有形状"（保留自研 `LlmMessage`/事件联合类型/工具接口/会话存储，
用 `ModelResolver`/`HistorySummarizer`/事件映射把 pi 包起来）。这条路线会让旧抽象长期存活：
每次 pi 升级都要维护一层翻译，产品侧永远享受不到 pi 的原生能力（会话持久化、任务图、
异常恢复、工具声明与校验）。**用户明确要求改为以 pi 为核心重新设计，遗留代码彻底清理。**

### 所有权划分（谁拥有什么）

| 领域 | 归属 | 说明 |
| --- | --- | --- |
| 消息与会话状态 | **pi**（`pi-agent-core` 的 `AgentMessage`、`pi-durable` entries + storage） | 我们不再定义 `LlmMessage`/会话项结构；快照与同步读 pi 持久化层 |
| 回合生命周期 | **pi**（`Agent.prompt()` / steering / follow-up / `finishTurn`） | 我们不再手写 8 项职责的循环；只在钩子与事件上挂产品逻辑 |
| 工具 | **pi**（`AgentTool` + typebox 参数 + `execute`） | 我们不再维护 JSON Schema 工具接口与自研注册表；工具= pi 工具 |
| 模型与 provider | **pi**（`pi-ai` + `models.json` 配置） | 企业模式走 `streamProxy`（服务端持密钥），不再自研 provider/SSE |
| MCP / 代码模式 | **pi**（`pi-mcp` / `pi-codemode`） | 删自研 MCP 客户端 |
| 权限 / 审批 / 审计 | **我们**（挂 `beforeToolCall`/`afterToolCall`） | 这是企业侧差异化能力，必须保留且不降级 |
| 用量与成本 | pi 提供用量 → **我们**落账与上报 | 数据源是 pi 的 `usage`，不再自算 |
| UI 事件（IPC） | **我们**，但定义为 **pi 事件在 IPC 边界的投影**（不是平行模型） | 渲染进程契约服务于界面；映射只发生在边界，主进程内部以 pi 类型为准 |
| 同步 / 市场 / 云 / 服务端 | **我们**（不变） | 与引擎无关 |

### 原则：反适配

1. 需要"把 pi 的事件/消息/工具翻译成我们的形状"的代码，**只有在 IPC/UI 边界**才允许存在，
   且必须是机械投影（字段改名、裁剪），不得引入第二套语义（例如我们自己定义 stopReason 枚举）。
2. 任何"为了不动旧代码而写的适配层"一律删除，哪怕它已经写完并通过测试。
3. 前几批产物中：`pi-runtime.ts`（`ModelResolver`/`HistorySummarizer` 接口）与 `pi-loop.ts`
   （复刻旧循环 8 项职责）属于**过渡态**，将在本次重构中替换为 pi 原生用法并删除；
   `pi-config.ts`（读 pi 的 `models.json`）与 `pi-governance.ts`（治理钩子）是 pi 原生用法，保留；
   `pi-events.ts` 收敛为"边界投影"。

### 删除清单（本次重构目标）

> **进度**：R5 第一批已删除 `model/providers/*`、`model/gateway.ts`、`model/errors.ts`、
> `agent/loop.ts`、`agent/compaction.ts`、`tools/registry.ts` 与 4 个旧工具实现，以及对应的 9 个旧测试文件
> （提交 `0d6c394`）。剩余项在 R1/R4 落地后删除。
>
> 更正：`agent/pi-loop.ts` 与 `model/pi-runtime.ts` **不是过渡件**——它们是切换后的正式实现
> （回合循环与运行时装配），不在删除清单内。

- `src/main/model/providers/*`（openai / openai-responses / anthropic / sse / json-args / types）✅ 已删
- `src/main/model/gateway.ts`、`src/main/model/errors.ts` ✅ 已删
- `src/main/agent/loop.ts`（旧循环）✅ 已删、`src/main/agent/compaction.ts` ✅ 已删（改用 pi 摘要器）
- `src/main/tools/registry.ts` 与旧工具实现 ✅ 已删（`shell.ts`/`types.ts` 暂留：MCP 客户端仍用，R4 删除）
- `src/main/session/{store,items,types}.ts`（改用 pi-durable 的 entries + storage；快照/同步改读它）
- `src/main/mcp/*`、`tools/{shell,types}.ts`、`tools/mcp_bridge.ts`（改用 `pi-mcp`）
- 对应测试 ✅ 已删（provider/agent-loop/compaction/deepseek*）
- `src/main/model/types.ts`（`LlmMessage` 等会话形状，随 R1 迁移完成后删除）

## 修订（2026-10-14，用户决策）：不使用门面，直接使用 `pi-durable`

### 集成方式已用真实模型验证（R1 落地配方）

回合由 harness 自跑，我们的能力以**扩展 + 钩子**接入（已实测，测试见
`app/tests/integration/pi_durable_hooks_real.test.ts`，仅用 `deepseek-v4.1-flash`）：

```ts
const Tools = defineExtension({ name: 'huagent.tools', tools: nativeTools })
const Guard = defineExtension({
  name: 'huagent.guard',
  sections: [section('workspace', () => buildSystemPrompt(...), { tag: false })],
  hooks: [hook(ToolTask, {
    // 异步钩子受支持：我们的权限引擎要 await 审批
    beforeTool: async (call) => { const d = await permissions.check(call); return d.action === 'allow' ? undefined : { block: d.reason } },
    // afterTool 可用于产物/截断（与现有 pi_governance 逻辑合并）
  })],
})
registry.install(Tools); registry.install(Guard)
await root.configure({ extensions: [Tools, Guard], tools: nativeTools, modelTools: nativeTools })
const submission = await root.submit({ type: 'input', content, requestId }, ctx)
await submission.wait(ctx)   // 运行是异步的：必须等 settle 或订阅 viewState
```

**实测得到的三个落地要点**：

1. 扩展只是**安装**；会话还需通过 `configure({ extensions, tools, modelTools })` **选择**扩展与工具，
   缺了 `tools`/`modelTools` 模型就看不到工具（这是最初 spike 卡住的真实原因）；
2. 运行是**异步任务**：`submit()` 返回 submission，必须 `submission.wait()`/`waitForIdle()` 或订阅 `viewState()`；
3. 用 faux provider 在 durable harness 里跑工具派发不可靠（它吞工具调用，settle 仍为 `done`）——
   这类“派发/钩子”验证必须走真实模型（已有门禁用例 `PI_E2E=1`）。

### 读取面形状（真实模型勘察结果，编码依据）

数据来源：`tests/integration/pi_durable_shapes_real.test.ts`（一次运行即得，可重跑复核）。

| 读取对象 | 实际形状 | 用法 |
| --- | --- | --- |
| `viewState().value.entries` | 数组；条目形如 `{ model: [pi 消息], kind: 'pi.user'／'pi.system'／…, id, conversationId, byTaskId? }` | 界面历史与消息投影读它（system 条目携带 `toolsAdded`、`sections`，可用于回放工具变更） |
| `docs['pi.live']` | **运行中才有内容，settle 后为 `{}`**。运行期形状已实测：`{ run: { taskId, inputs }, generation?: { attempt, message: AssistantMessage } , tools?: [{ callId, name, taskId, status: 'pending'｜'running'｜'done', entry? }] }` | 实时投影：流式增量取 `generation.message.content[]`（`thinking`／`text`／`toolCall` 块，追加式，可 diff 出增量）；工具卡片按 `tools[].status` 走 pending→running→done，done 后按 `entry` 从 `entries` 读结果 |
| `docs['pi.usage']` | `{ models: { 'provider/model': { input, output, cacheRead, cacheWrite, reasoning, totalTokens, cost } }, tools: {} }` | 用量落账与上报的数据源（比我们自算的更全：含 reasoning 与 cost） |
| `docs['pi.agent']` | 已解析的会话配置（model/extensions/tools/modelTools/…） | 会话选项展示 |
| `docs['pi.inbox']` | `{ items: [] }`（队列） | 排队的输入/跟进 |
| `harness.usage()` | 与 `docs['pi.usage']` 同形（整会话汇总） | 会话级汇总 |

原计划是写一个"会话门面"：用 pi-durable 的存储去实现我们旧的 `SessionStore` 接口
（`append/loadContextMessages/loadOptions/touch`）。用户直接指出这仍是"用 pi 适配旧编程模式"，判断正确：
门面会重建一套我们自己定义的消息/条目形状与读写时机，等于把旧模型永久保留下来。

改为**直接集成**：会话、消息、回合、用量归 pi-durable；我们只在**边界**读它做 UI/同步投影。

| 我们需要的能力 | pi-durable 原生提供 |
| --- | --- |
| 会话选项（模型/思考强度/工作目录/工具集/附加指令） | `root.configure({ model, thinkingLevel, cwd, tools, modelTools, instructions })`，按会话持久化在 `pi.agent` 文档，未设字段回落宿主 |
| UI 实时状态（transcript、流式增量、工具调用与结果） | `root.viewState()` → `entries` + `docs["pi.live"]` + `pi.inbox`/`pi.usage`/`pi.agent`/`pi.provider`，可 `subscribe`；`watch()` 给出每次提交的 Chord 操作序列 |
| 用量与成本 | `docs["pi.usage"]`（按 provider/model 与 tool 分账，含失败/中断）+ `harness.usage()` 整会话汇总 |
| 系统提示 | extension sections + `instructions` 组装，按位置增量发送（保 prompt cache） |
| 每会话自持状态 | `defineDoc` 类型化文档 + `harness.watchDoc()` + `conversationCreated` 钩子 |
| 崩溃恢复 / 重试幂等 | `resume()` 续跑未完成运行；`submit({ requestId })` 跨重启幂等（已 spike 验证） |

**我们仍然拥有（不交给 pi）**：权限判定与审批（`beforeToolCall`/`afterToolCall`）、审计（本地 + 服务端）、
artifact 与备份、用量落账与上报（数据源换成 pi 的 usage）、同步/市场/服务端、IPC 事件的边界投影。

**因此删除清单新增**：`session/{store,items,types}.ts` 与 `model/types.ts` 的会话形状部分（`LlmMessage` 等），
以及原计划的 JSONL ↔ durable 双写与迁移脚本（改为一次性导入旧本地会话或归档为只读）。

### R1 最后一批：影响面与逐处理器映射（实测清单，照此执行）

`SessionStore` 的消费方只有：`ipc.ts`（8 个 `sessions:*` 处理器）、`pi_runner.ts`、旧 `pi_loop.ts`、
`agent/events.ts`（仅类型）与 3 个测试；**同步/统计不依赖它**（`sync/scan.ts` 只把 `.hu/sessions` 当作排除路径）。

| 现有处理器 | 改为 | 说明 |
| --- | --- | --- |
| `sessions:list` | `DurableSessions.list()`（视图索引） | 索引字段 id/title/createdAt/updatedAt/workspaceId → 映射到现有 `SessionSummaryView` |
| `sessions:create` | `DurableSessions.create({ title, model })` | 模型取 `defaults.primary`；返回新建的摘要 |
| `sessions:items` | `DurableSessions.view(id)` 的 `entries` → 消息/工具卡视图 | `kind: 'pi.user'｜'pi.system'｜…` + `model: [pi 消息]`；system 条目跳过（不渲染） |
| `sessions:rename` | 写视图索引的 title | durable 不存标题：标题属索引（界面元数据），不是会话真相 |
| `sessions:options` | `DurableSessions.agentConfig(id)` | 返回已解析的 model/thinkingLevel/instructions |
| `sessions:set-options` | `DurableSessions.configure(id, …)` | `reasoningEffort` → `thinkingLevel` 映射 |
| `sessions:stats` | `DurableSessions.usage()`（`pi.usage`） | 取代自算的 `computeSessionUsage`（数据更全：含 cache/reasoning/cost） |
| `sessions:search` | 扫描 `entries` 文本 | 会话数量在小规模下可接受；必要时后补索引 |

配合改动：`pi_runner.ts` 改接 `agent/durable_loop.ts`（`DurableSessions` 取代 `SessionStore`；
会话 id 即 durable 会话 id）；`index.ts` 创建 `DurableSessions`（注入 pi_runtime 的 models 集合）并传给
`createRunner`；旧本地 JSONL 会话先**归档为只读**（导入脚本可后补）。

删除：`session/{store,items,types}.ts`、`agent/pi_loop.ts`（被 `durable_loop.ts` 取代）及
`session_store/session_items/session_stats` 三个测试。


## 后果与待办

- **体积**：核心包解包约 10 MB（`pi-ai` 4.2 MB、`pi-durable` 3.2 MB、`chord` 1.5 MB…），另有 `pi-ai`
  的传递依赖（`openai`、`@anthropic-ai/sdk`、`@google/genai`、`@aws-sdk/client-bedrock-runtime`）。
  `pi-env` 18 MB（含 Rust daemon）只在 P5 且作为可选特性。需要在 P6 做打包排除与体积复核。
- **上游风险**：`pi-durable` 自述 Experimental（API 不通知地变更）。缓解：存储适配层薄化、版本精确 pin、
  迁移脚本 + 回滚开关；若上游破坏性变更影响生产，回落到 P3 之前的自研存储。
- **迁移成本**：会话数据需从现有 items 迁到 durable entries（P3 提供一次性迁移脚本 + 双读校验）。
- **`pi-coding-agent` 体积**：23 MB 解包，依赖里含 `pi-tui`/`mermaid`/`highlight.js` 等界面相关包。
  缓解：只 import `ModelRegistry` 等具体模块，靠 Rollup tree-shaking 收窄；打包阶段用 electron-builder
  的 files 排除未用包；P1 出口标准包含「main 包体积增量复核」，超出预期就切决策 8 的备选路径。
- **文档同步**：`design.md` 客户端架构章节、`plan.md` 阶段条目在 **P1–P5 各阶段落地时与代码同提交**
  改写（附录 F）；`docs/optimization.md` 记录计划与进度；新增 `NOTICE` 与第三方许可清单（P6）。
