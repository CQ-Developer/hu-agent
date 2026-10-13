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
- [ ] **阶段 1：Agent MVP（待开始）**

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
