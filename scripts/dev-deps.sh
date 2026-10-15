#!/usr/bin/env bash
# 本地开发依赖的起停脚本（统一使用 docker/compose.yaml，profile: sso + mail）
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker/compose.yaml"
# 只起依赖：不启用 app/monitoring/logs profile（API/worker 在宿主机跑）
PROFILES=(--profile sso --profile mail)
SERVICES=(postgres redis minio keycloak mailpit)

case "${1:-up}" in
  up)
    docker compose -f "$COMPOSE_FILE" "${PROFILES[@]}" up -d "${SERVICES[@]}"
    docker compose -f "$COMPOSE_FILE" "${PROFILES[@]}" ps
    ;;
  down)
    docker compose -f "$COMPOSE_FILE" "${PROFILES[@]}" down
    ;;
  reset)
    echo "警告：将删除本地依赖的全部数据卷（PG/Redis/MinIO）。5 秒后继续，Ctrl+C 取消..."
    sleep 5
    docker compose -f "$COMPOSE_FILE" "${PROFILES[@]}" down -v
    docker compose -f "$COMPOSE_FILE" "${PROFILES[@]}" up -d "${SERVICES[@]}"
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" "${PROFILES[@]}" ps
    ;;
  *)
    echo "用法: $0 up|down|reset|status" >&2
    exit 1
    ;;
esac
