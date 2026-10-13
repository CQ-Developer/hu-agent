# hu-agent-app（桌面客户端）

Electron + React + TypeScript 骨架（electron-vite 构建，electron-builder 打包）。

## 常用命令

```bash
npm install        # 首次安装依赖（生成 package-lock.json，请提交）
npm run dev        # 开发模式：开窗 + HMR
npm run typecheck  # 主进程/预加载 + 渲染进程类型检查
npm run test       # Vitest 单测（会话存储、工具、截断、用量、Loop 冒烟、SSE 解析）
npm run build      # 构建到 out/
npm run dist       # 打 Windows 安装包（需要签名时配置证书，见 docs/design.md 9.5）
npm run dist:mac   # 打 macOS dmg（需 Developer ID 与公证配置）
```

> 若 `npm install` 卡在 Electron 二进制下载（GitHub 超时），使用镜像：
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`

## 目录结构

```
src/main/       # 主进程（窗口、IPC、后续的 Agent Core）
src/preload/    # 预加载脚本（contextBridge 暴露 window.huAgent）
src/renderer/   # 渲染进程（React 界面）
```

## 安全基线（design 5.1）

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；
- 渲染进程启用 CSP（见 `src/renderer/index.html`）；
- 外链一律经系统浏览器打开，禁止应用内导航到外部页面；
- 渲染进程只能通过 `window.huAgent` 的白名单方法访问主进程能力。

## 当前状态

- [x] **阶段 0：骨架**（三进程结构、类型化 IPC、打包配置）
- [x] **阶段 1：Agent MVP**
  - [x] Agent Loop + 事件流 + 取消/最大轮次（`src/main/agent`）
  - [x] 模型网关：OpenAI 兼容流式 + function calling + 重试（`src/main/model`）
  - [x] 会话 JSONL：append-only、索引可重建、崩溃容错（`src/main/session`）
  - [x] 内置工具：read_file / write_file / edit_file / bash / powershell（截断 + artifact）
  - [x] 聊天 UI：流式消息、工具卡片、会话列表、模型设置抽屉
  - [x] 输入框：会话级模型选择、思考强度（需模型声明支持）、输入/输出 tokens、缓存命中率、上下文剩余百分比
  - [x] 思考内容展示：可折叠思考块（流式默认展开，历史默认折叠），随消息落盘但不回传模型
  - [x] 模型配置支持 API 类型：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages（含思考强度映射与签名回放）
  - [x] 本地用量账本 + 侧边栏统计
  - [x] 真实模型联调：DeepSeek 三种协议（8 个集成用例，见下）
  - [x] 66 个单测（`npm run test`）

### 阶段 2：Workspace 与安全（进行中）

- [x] 工作空间：目录选择/切换、`.hu` 初始化、多工作空间索引（`~/.hu-agent/workspaces.json`）
- [x] 权限引擎：决策矩阵（工作空间内 allow / 越界 ask / 敏感与保护文件 deny）、realpath 防逃逸、符号链接、Windows 保留名与 UNC
- [x] 授权卡片：允许一次 / 本会话 / 始终（持久化到工作空间策略）；保护文件拦截
- [x] 审计：`.hu/logs/audit.jsonl`
- [x] ask_guide 引导卡片
- [x] Shell 加固：超时/取消终止进程树、输出限量与截断标注
- [x] 会话全文搜索
- [x] 历史压缩（summary 行 + 快速模型 + `session.compacted` 事件）
- [x] 移除 Electron 默认应用菜单栏
- [x] 界面导航：顶部配置 Tab + 左下角个人中心
- [ ] macOS 平台实测

### 阶段 3：本地 Skill / MCP 机制（已完成，3-05 可延后）

- [x] Skill：目录扫描（全局/工作空间，支持无版本与版本目录）、双作用域启停、系统提示注入
- [x] Skill 信任提示（启用前展示声明的工具/依赖/网络权限）
- [x] MCP stdio 客户端：initialize 握手、tools/list 分页、tools/call、超时/取消、重连退避、空闲回收
- [x] MCP 工具注入 `mcp__<server>__<tool>`，经权限引擎（默认本会话首次询问）
- [x] MCP 配置 tab：增删改、全局/工作空间启停、测试连接、状态与错误展示（密钥只留 secret:// 引用）
- [ ] MCP HTTP/SSE 传输（3-05）

### 阶段 4：账号与用量上报（已完成）

- [x] 云账户客户端：登录、refresh 入 safeStorage、401 自动刷新一次、登出、设备列表与吊销
- [x] 上报队列：未登录不入队、批量 ≤100、字节位点确认、退避（1m/5m/30m/2h）、50MB/7 天上限与压实
- [x] 会话哈希带每工作空间随机盐；上报不含提示词/路径/工具参数
- [x] 个人中心：账号、设备与安全、待上报数、立即上报、清空队列
- [x] 强制登录（D16 / ADR 0004）：启动登录门禁（登录/注册 + 服务器地址），未登录不可进入主界面；服务端拒绝会话时退回门禁

> 注意：服务端不可达时无法进入应用（企业身份管控要求），门禁只提供重试。

## 真实模型集成测试（需要密钥，默认跳过）

```bash
DEEPSEEK_API_KEY=... npx vitest run tests/integration/deepseek.test.ts            # OpenAI Chat 协议
DEEPSEEK_API_KEY=... npx vitest run tests/integration/deepseek-anthropic.test.ts  # Anthropic Messages 协议
DEEPSEEK_API_KEY=... npx vitest run tests/integration/deepseek-responses.test.ts  # OpenAI Responses 协议
```

密钥只从环境变量读取，不落盘；三种协议均覆盖基础流式对话与 Agent 工具调用链路。
