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
uv run python scripts/export_openapi.py   # 重新生成 ../openapi/openapi.json（不要手改）
```

## 已实现接口（阶段 4）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/register` | 邮箱注册（可用 `HUAGENT_AUTH_REGISTRATION_ENABLED=false` 关闭） |
| POST | `/api/v1/auth/login` | 本地账号登录，绑定设备，签发 access + refresh |
| POST | `/api/v1/auth/refresh` | 旋转刷新，重放检测（撤销该设备全部会话 + 通知） |
| POST | `/api/v1/auth/logout` | 单设备/全部设备注销 |
| GET | `/api/v1/auth/providers` | 可用登录方式 |
| GET/PATCH | `/api/v1/me` | 个人资料 |
| GET/DELETE | `/api/v1/me/devices` `/{deviceId}` | 设备列表 / 吊销 |
| POST | `/api/v1/usage:batch` | 用量批量上报（≤100 条，幂等，归属校验） |

安全参数（`HUAGENT_*`）：`JWT_SECRET`（生产必换）、`ACCESS_TOKEN_TTL_SECONDS`、`REFRESH_TOKEN_TTL_SECONDS`、`LOGIN_IP_LIMIT`、`LOGIN_FAIL_THRESHOLD`、`RATE_LIMIT_STRICT`、`WEAK_PASSWORD_FILE`。

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
