#!/usr/bin/env bash
# 本地开发依赖的起停脚本，详见 docker/compose.yaml
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker/compose.yaml"
ACTION="${1:-up}"

case "$ACTION" in
  up)
    docker compose -f "$COMPOSE_FILE" up -d
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  down)
    docker compose -f "$COMPOSE_FILE" down
    ;;
  reset)
    echo "警告：将删除本地依赖的全部数据卷（PG/Redis/MinIO）。5 秒后继续，Ctrl+C 取消..."
    sleep 5
    docker compose -f "$COMPOSE_FILE" down -v
    docker compose -f "$COMPOSE_FILE" up -d
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  *)
    echo "用法: $0 up|down|reset|status" >&2
    exit 1
    ;;
esac
