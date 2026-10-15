# hu-agent 服务端镜像（API 与 worker 共用）
#
# 构建（在仓库根目录）：
#   docker build -f management/Dockerfile -t huagent-management:local .
#
# 说明：Python 版本与 uv 版本显式固定，`uv sync --frozen` 严格按 uv.lock 安装，保证可复现。

FROM python:3.14-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    HUAGENT_DDL_DIR=/app/db/ddl \
    PATH="/app/.venv/bin:$PATH"

COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /uvx /usr/local/bin/

WORKDIR /app

# 1) 先只装依赖（利用层缓存：源码变化不会重装依赖）
COPY management/pyproject.toml management/uv.lock management/README.md ./
RUN uv sync --frozen --no-dev --no-install-project

# 2) 源码 + DDL（迁移命令需要 db/ddl）
COPY management/src ./src
COPY db/ddl ./db/ddl
RUN uv sync --frozen --no-dev

# 非 root 运行
RUN useradd --create-home --uid 10001 huagent && chown -R huagent:huagent /app
USER huagent

EXPOSE 8080

# 默认启动 API；worker 用同一镜像覆盖 command（见 docker/compose.yaml）
CMD ["huagent-api"]
