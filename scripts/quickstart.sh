#!/usr/bin/env bash
# 一条命令起全栈（评估 / 小型自托管）：
#   scripts/quickstart.sh up [--email you@example.com] [--with-sso]
#   scripts/quickstart.sh down
#   scripts/quickstart.sh logs [服务名]
#   scripts/quickstart.sh admin --email you@example.com
#
# 行为：
# 1) 首次运行时生成 .env.quickstart（随机数据库口令、JWT_SECRET、MASTER_KEY）并提示保存；
# 2) 构建镜像并启动 PostgreSQL/Redis/MinIO/API/worker；
# 3) 应用数据库 DDL（huagent-admin db-migrate）；
# 4) 创建首个系统管理员（未提供 --email 时交互式询问，口令随机生成并打印一次）。
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
ENV_FILE="$ROOT/.env.quickstart"
COMPOSE=(docker compose -f docker/compose.quickstart.yaml --env-file "$ENV_FILE")

banner() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

random_secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(32))' 2>/dev/null || openssl rand -base64 32 | tr -d '\n'; }
random_master_key() { python3 -c 'import base64,secrets; print(base64.b64encode(secrets.token_bytes(32)).decode())' 2>/dev/null || openssl rand -base64 32 | tr -d '\n'; }

require_docker() {
  command -v docker >/dev/null 2>&1 || fail "未找到 docker，请先安装 Docker（或改用 docs/delivery/deployment.md 的手工部署）"
  docker compose version >/dev/null 2>&1 || fail "需要 docker compose v2（docker compose version 不可用）"
}

ensure_env_file() {
  if [[ -f "$ENV_FILE" ]]; then return; fi
  banner "生成 $ENV_FILE（随机口令与密钥）"
  cat >"$ENV_FILE" <<EOF
# hu-agent 快速开始配置（由 scripts/quickstart.sh 生成，请妥善保存并加入 .gitignore）
POSTGRES_PASSWORD=$(random_secret)
MINIO_ROOT_USER=huagent
MINIO_ROOT_PASSWORD=$(random_secret)
JWT_SECRET=$(random_secret)
MASTER_KEY=$(random_master_key)
PUBLIC_BASE_URL=http://127.0.0.1:8080
# 管理台/客户端跨域来源（JSON 数组），例如：["https://console.example.com"]
CORS_ORIGINS=[]
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
  echo "已生成（内容含密钥，请注意保密；丢失 MASTER_KEY 将无法解密身份源密钥）"
}

wait_healthy() {
  banner "等待服务就绪"
  for _ in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:8080/api/v1/system/health >/dev/null 2>&1; then
      echo "API 已就绪"
      return
    fi
    sleep 3
  done
  fail "API 未在预期时间内就绪，请查看：scripts/quickstart.sh logs api"
}

cmd_up() {
  local email="" sso=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email) email="$2"; shift 2 ;;
      --with-sso) sso=1; shift ;;
      *) fail "未知参数：$1" ;;
    esac
  done
  require_docker
  ensure_env_file

  banner "构建镜像并启动依赖（PostgreSQL / Redis / MinIO${sso:+ / Keycloak}）"
  local deps=(postgres redis minio)
  local profile_args=()
  if [[ $sso -eq 1 ]]; then
    deps+=(keycloak)
    profile_args=(--profile sso)
  fi
  "${COMPOSE[@]}" "${profile_args[@]}" up -d --build --wait "${deps[@]}"

  # 迁移必须在 API 启动前完成：API 启动时会校验 schema 版本（design 6.8.3）
  banner "应用数据库 DDL"
  "${COMPOSE[@]}" run --rm --no-deps api huagent-admin db-migrate

  banner "启动 API 与 worker"
  "${COMPOSE[@]}" "${profile_args[@]}" up -d --wait api worker
  wait_healthy

  banner "创建首个系统管理员"
  if [[ -z "$email" ]]; then
    read -r -p "管理员邮箱（回车跳过，可稍后用 scripts/quickstart.sh admin 创建）: " email
  fi
  if [[ -n "$email" ]]; then
    "${COMPOSE[@]}" exec -T api huagent-admin create-admin --email "$email"
  else
    echo "已跳过（稍后执行：scripts/quickstart.sh admin --email you@example.com）"
  fi

  banner "完成"
  cat <<'EOF'
服务地址：
  API        http://127.0.0.1:8080/api/v1/system/health
  指标       http://127.0.0.1:8080/api/v1/system/metrics
  MinIO 控制台 http://127.0.0.1:9001（凭据见 .env.quickstart）

后续步骤：
  1) 启动管理台：cd management-ui && npm ci && npm run dev   （http://localhost:5173）
  2) 启动客户端：cd app && npm ci && npm run dev
  3) 客户端登录页「服务器地址」填 http://127.0.0.1:8080
  4) 自验证清单：docs/validation.md  ·  部署与运维：docs/delivery/
EOF
}

cmd_down() { require_docker; ensure_env_file; "${COMPOSE[@]}" down "$@"; }
cmd_logs() { require_docker; ensure_env_file; "${COMPOSE[@]}" logs -f --tail=200 "$@"; }

cmd_admin() {
  require_docker
  ensure_env_file
  "${COMPOSE[@]}" exec -T api huagent-admin "$@"
}

case "${1:-up}" in
  up) shift || true; cmd_up "$@" ;;
  down) shift || true; cmd_down "$@" ;;
  logs) shift || true; cmd_logs "$@" ;;
  admin) shift || true; cmd_admin "$@" ;;
  *) fail "用法：scripts/quickstart.sh {up|down|logs|admin} …" ;;
esac
