# hu-agent-management（服务端）

Python 3.14 + FastAPI + SQLAlchemy 2.0 + PostgreSQL 18，依赖与运行时由 [uv](https://docs.astral.sh/uv/) 管理。

## 常用命令

```bash
uv sync                  # 安装依赖并生成/更新 uv.lock（首次运行后请提交 uv.lock）
uv run huagent-api       # 启动 API（默认 127.0.0.1:8080，需先建库，见 ../README.md）
uv run huagent-worker    # 启动后台任务进程
uv run pytest -q         # 单元测试（不需要数据库）
uv run ruff check .      # lint
uv run ruff format .     # format
uv run mypy src          # 类型检查
```

## 集成测试（需要 Docker）

```bash
HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
```

集成测试用 Testcontainers 起 `postgres:18-alpine`，执行 `../db/ddl/V0001__init.sql` 并校验 `schema_versions`。

## 目录结构

```
src/huagent/
  common/    # 错误码、配置、通用工具
  api/       # FastAPI 应用、路由、错误处理、中间件
  domain/    # 领域服务与数据访问（SQLAlchemy）
  storage/   # S3/MinIO 封装
  worker/    # APScheduler 定时任务
tests/       # 单元测试（tests/integration 为需要 Docker 的集成测试）
```

约定与设计见 `../docs/design.md`（6.1 工程结构、6.8 数据模型、6.9 API）。
