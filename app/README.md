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

## 当前状态（阶段 0-05）

- [x] 三进程结构与类型化 IPC（`app:get-version` 示例）
- [x] electron-builder 打包配置（NSIS / dmg）
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
  - [x] 40 个单测（`npm run test`）
  - [x] 真实模型联调：DeepSeek `deepseek-flash` 流式对话 + 工具调用（集成测试见下）

## 真实模型集成测试（需要密钥，默认跳过）

```bash
DEEPSEEK_API_KEY=... npx vitest run tests/integration/deepseek.test.ts            # OpenAI Chat 协议
DEEPSEEK_API_KEY=... npx vitest run tests/integration/deepseek-anthropic.test.ts  # Anthropic Messages 协议
DEEPSEEK_API_KEY=... npx vitest run tests/integration/deepseek-responses.test.ts  # OpenAI Responses 协议
```

密钥只从环境变量读取，不落盘；三种协议均覆盖基础流式对话与 Agent 工具调用链路。
