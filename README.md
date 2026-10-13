# hu-agent

企业级 Agent 平台。三个组件同仓开发（monorepo）：

| 目录 | 组件 | 技术栈 |
| --- | --- | --- |
| `app/` | 桌面客户端 | Electron + TypeScript |
| `management/` | 服务端 | Python 3.14 + FastAPI + SQLAlchemy + PostgreSQL 18（uv 管理） |
| `management-ui/` | 管理台 | Vite + React + Ant Design |

设计文档与执行计划：

- [`docs/design.md`](docs/design.md)：设计基线（接口、数据模型、安全机制）
- [`docs/plan.md`](docs/plan.md)：执行计划（阶段 0-7、完成标准、延后清单）
- [`docs/adr/`](docs/adr/)：关键决策记录（ADR）

> 硬性纪律：任何设计与决策变动，必须在同一次提交内同步更新 `docs/` 下的文档（见 `docs/plan.md` 附录 F）。

## 当前进度

- [x] 设计冻结（design.md v1.2，D1-D15 已确认）
- [x] **阶段 0：技术验证与骨架（已验收）**
  - [x] 仓库与目录骨架
  - [x] 本地依赖 docker compose（PG18 卷挂载已按镜像约定修正）
  - [x] `db/ddl/V0001__init.sql`（已在 PG18 验证：建库 / 幂等 / 种子 / 回滚）
  - [x] 服务端骨架（FastAPI + SQLAlchemy + worker + 测试）
  - [x] 服务端 spike：`uv sync` / ruff / mypy / pytest / 真实启动 / OpenAPI 导出全部通过
  - [x] Electron 骨架（electron-vite + 类型化 IPC + 打包配置）
  - [x] 客户端验证：typecheck 与 build 通过
  - [x] 管理台骨架（Vite + AntD + 路由 + i18n + 健康检查联调）
  - [x] 管理台验证：typecheck、build、经 dev 代理调 API 均通过
  - [x] CI 流水线（management / app / management-ui）
- [ ] **阶段 1：Agent MVP（进行中）**
  - [x] 模型网关（OpenAI 兼容：流式 + function calling + 错误分类/重试）
  - [x] Agent Loop（事件流、取消、max_steps、上下文重建）
  - [x] 会话 JSONL 持久化（append-only、索引可重建、崩溃容错、artifact）
  - [x] 内置工具：read_file / write_file / edit_file / bash / powershell
  - [x] 最小聊天 UI（流式渲染、工具卡片、会话列表、模型设置、Markdown 消毒）
  - [x] 本地用量账本与统计
  - [x] 单测 40 个 + typecheck + 构建全绿
  - [x] 三种 API 协议真实联调（DeepSeek 端点，8 个集成用例）：openai-chat / anthropic-messages / openai-responses
  - [x] 输入框模型选择 / 思考强度 / 用量与上下文指示（1-08）
  - [x] 思考内容展示：可折叠思考块，落盘且不回传模型（1-09）
  - [x] 模型配置支持 API 类型选择：OpenAI Chat / OpenAI Responses / Anthropic Messages（1-10）
- [ ] **阶段 2：Workspace 与安全（进行中）**
  - [x] 工作空间管理与切换（目录选择、`.hu` 初始化、多工作空间索引）
  - [x] 权限引擎与路径沙箱（决策矩阵、realpath 防逃逸、Windows 保留名/UNC、敏感路径硬拒绝）
  - [x] 授权卡片（允许一次 / 本会话 / 始终）+ 保护文件拦截 + 审计日志
  - [x] ask_guide 交互卡片
  - [x] Shell 加固（超时/取消终止进程树、输出限量、非 UTF-8 替换）
  - [x] 会话全文搜索
  - [x] 历史压缩（summary 行 + 快速模型 + `session.compacted` 事件）
  - [x] 移除 Electron 默认应用菜单栏
  - [x] 界面导航：顶部配置 Tab（对话/模型/Skill/MCP/工作空间/权限与审计/关于）+ 左下角个人中心
  - [ ] macOS 平台用例实测
- [x] **阶段 3：本地 Skill / MCP 机制（已完成，3-05 可延后）**
  - [x] Skill：目录扫描（全局/工作空间+版本目录）、双作用域启停、系统提示注入
  - [x] Skill 信任提示（启用前展示声明的工具/依赖/网络权限）
  - [x] MCP 客户端（stdio）：握手、分页 tools/list、tools/call、重连与空闲回收
  - [x] MCP 工具注入（mcp__server__tool）与权限引擎对接（本会话首次询问）
  - [x] MCP 配置 tab：增删改、双作用域启停、测试连接、状态/错误展示
  - [x] 真实 MCP server 联调（filesystem：发现 14 个工具并成功读文件）
  - [ ] MCP HTTP/SSE 传输（3-05，计划中标记可延后）
- [x] **阶段 4：账号与用量上报（已完成）**
  - [x] 服务端：注册/登录/旋转刷新（重放检测）/登出/设备管理（argon2id + PyJWT + 登录限流）
  - [x] 服务端：`POST /usage:batch` 幂等写入分区表，归属校验与时间窗校验
  - [x] 客户端：登录、令牌管理（refresh 入 safeStorage，401 自动刷新一次）、设备列表与吊销
  - [x] 客户端：上报队列（未登录不入队、批量、字节位点确认、退避重试、50MB/7 天上限）
  - [x] 个人中心：登录/设备/待上报数/立即上报/清空队列；隐私边界说明
  - [x] **强制登录（D16 / ADR 0004）**：启动即登录门禁，未登录不可进入主界面；会话被撤销时自动退回门禁
  - [x] 实测对账：本地 3 条记账 ↔ 服务端 `usage_events` 完全一致（误差 0%）
- [ ] **阶段 5：协作与市场（服务端已完成，客户端进行中）**
  - [x] 组织/团队/成员/邀请（申请 → 审批 → 创建；邀请码一次性、7 天；最后管理员保护）
  - [x] RBAC 与范围断言（不可见一律 404；组织管理员越权写审计 `rbac.override.*`）
  - [x] 通用审批流（四种类型、状态机单调、驳回必填意见、站内通知）
  - [x] Skill 市场服务端（流式上传 + zip 安全校验、版本审批发布、预签名下载、上下架/停用/撤回/删除、pg_trgm 搜索）
  - [x] 资源状态查询与激活上报（`/resources/status:check`、`/me/activations:report`、定向通知）
  - [x] 管理台延后时的代办脚本 `scripts/stage5-admin.http`
  - [ ] 客户端市场（浏览/下载/校验/安全解压/安装/双作用域启停）—— 5-05
  - [ ] 客户端状态同步与硬停用生效 —— 5-07
  - [ ] MCP 市场（5-08）、管理台（5-09）—— 计划中可延后

## 环境要求

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| uv | 0.13+ | 服务端依赖与 Python 运行时管理（已安装：`~/.local/bin/uv`） |
| Python | 3.14 | 由 uv 管理（本机已装 3.14.7，`uv python install 3.14` 可补装） |
| Node.js | 24+ | 客户端与管理台 |
| Docker | 24+ | 本地依赖（PostgreSQL/Redis/MinIO/Keycloak/Mailpit） |

首次使用服务端时安装依赖（会生成锁文件 `management/uv.lock`，请提交）：

```bash
cd management && uv sync
```

## 快速开始

```bash
# 1. 启动本地依赖（PG18 / Redis / MinIO / Keycloak / Mailpit）
scripts/dev-deps.sh up

# 2. 初始化数据库（按编号顺序执行 db/ddl/V*.sql）
scripts/ddl-apply.sh

# 3. 启动服务端（首次先 cd management && uv sync）
cd management && uv run huagent-api

# 4. 服务端健康检查
curl http://localhost:8080/api/v1/system/health
```

> 本机端口：PostgreSQL `5432`、Redis `6379`、MinIO `9000/9001`、Keycloak `8081`、Mailpit `1025/8025`、服务端 `8080`。

客户端：

```bash
cd app && npm install   # 首次安装（生成 package-lock.json，请提交）
npm run dev             # 开窗验证
```

管理台：

```bash
cd management-ui && npm install
npm run dev             # http://localhost:5173，概览页应显示服务端 ok
```

## 常用脚本

| 脚本 | 作用 |
| --- | --- |
| `scripts/dev-deps.sh up\|down\|reset\|status` | 起停本地依赖 |
| `scripts/ddl-apply.sh` | 执行未应用的 DDL 并记录到 `schema_versions` |
| `scripts/check-all.sh` | lint + 单测 + 构建（缺失工具链时自动跳过并提示） |

## 数据库变更纪律

- DDL 脚本放 `db/ddl/V000N__描述.sql`，只追加不改写；重要变更附 `db/rollback/R000N__描述.sql`
- 应用启动不执行 DDL；`schema_versions` 版本不匹配时拒绝启动（fail fast）
- 详细规范见 `docs/design.md` 6.8.3

## 已知问题（当前网络环境）

- **GitHub 下载超时**：`npm install` 时 Electron 二进制会从 GitHub 下载，可能超时；
  可用镜像：`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`。
- **rollup 4.64.6 tarball 缺失**：`app` 与 `management-ui` 的 `package.json` 用 `overrides` 临时锁定 `4.64.5`，registry 修复后可移除。
- **psycopg async 与 Windows 事件循环**：服务端入口已统一使用 `huagent.common.runtime.new_event_loop`（Selector loop），不要直接用默认 `asyncio.run` 连数据库。
