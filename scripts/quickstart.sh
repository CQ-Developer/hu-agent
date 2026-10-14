#!/usr/bin/env bash
# 一条命令起全栈（评估 / 小型自托管）：
#   scripts/quickstart.sh up [--email you@example.com] [--with-sso] [--with-monitoring]
#   scripts/quickstart.sh down
#   scripts/quickstart.sh reset          # 停止并删除数据卷（数据不可恢复，谨慎使用）
#   scripts/quickstart.sh logs [服务名]
#   scripts/quickstart.sh admin --email you@example.com
#
# 监控栈（Prometheus + Grafana + Alertmanager，可选 Loki 日志聚合）：
#   scripts/quickstart.sh monitoring up [--with-logs] [--target host.docker.internal:8080]
#   scripts/quickstart.sh monitoring status
#   scripts/quickstart.sh monitoring logs
#   scripts/quickstart.sh monitoring down      # 只停监控，不影响业务服务
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
# 叠加可观测性编排（同项目 → 服务名互通，Prometheus 可直接抓 api:8080）
COMPOSE_ALL=(docker compose -f docker/compose.quickstart.yaml -f docker/compose.observability.yaml --env-file "$ENV_FILE")
OBS_DIR="$ROOT/docker/observability"

banner() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

random_secret() { python3 -c 'import secrets; print(secrets.token_urlsafe(32))' 2>/dev/null || openssl rand -base64 32 | tr -d '\n'; }
random_master_key() { python3 -c 'import base64,secrets; print(base64.b64encode(secrets.token_bytes(32)).decode())' 2>/dev/null || openssl rand -base64 32 | tr -d '\n'; }

# 从 .env.quickstart 读取变量的值（未定义则用默认值）
env_get() {
  local key="$1" default="${2:-}" value=""
  [[ -f "$ENV_FILE" ]] && value="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  printf '%s' "${value:-$default}"
}

# 补齐缺失的配置项（幂等），例如为监控栈追加 METRICS_TOKEN
ensure_env_var() {
  local key="$1" default="$2"
  [[ -n "$(env_get "$key")" ]] && return
  printf '\n%s=%s\n' "$key" "$default" >>"$ENV_FILE"
}

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
# 监控栈（scripts/quickstart.sh monitoring up 时使用）
METRICS_TOKEN=$(random_secret)
GRAFANA_ADMIN_PASSWORD=$(random_secret)
ALERT_EMAIL_FROM=huagent-alerts@localhost
ALERT_EMAIL_TO=alerts@example.com
SMTP_SMARTHOST=mailpit:1025
SMTP_REQUIRE_TLS=false
HUAGENT_METRICS_TARGET=api:8080
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
  local email="" sso=0 monitoring=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --email) email="$2"; shift 2 ;;
      --with-sso) sso=1; shift ;;
      --with-monitoring) monitoring=1; shift ;;
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
  if ! "${COMPOSE[@]}" run --rm --no-deps api huagent-admin db-migrate; then
    cat <<'EOF' >&2

[quickstart] 迁移失败。最常见原因：该目录之前用过不同的 .env.quickstart（数据卷里的库口令与当前配置不一致）。
             如果这份数据可以丢弃，执行：scripts/quickstart.sh reset  然后重新 up。
             需要保留数据时，请把原 .env.quickstart 恢复回来再试。
EOF
    exit 1
  fi

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

  if [[ $monitoring -eq 1 ]]; then
    cmd_monitoring up
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
  5) 监控栈：scripts/quickstart.sh monitoring up   （Grafana http://localhost:3000）
EOF
}

# 生成监控栈所需文件（幂等）：指标令牌、抓取目标、告警路由
ensure_observability_files() {
  local target="$(env_get HUAGENT_METRICS_TARGET api:8080)" template="$OBS_DIR/alertmanager/alertmanager.yml.template"
  mkdir -p "$OBS_DIR/prometheus/targets"
  # 指标端点 Bearer 令牌（Prometheus 用 credentials_file 读取，避免明文进配置）
  printf '%s' "$(env_get METRICS_TOKEN)" >"$OBS_DIR/prometheus/huagent_metrics_token"
  chmod 600 "$OBS_DIR/prometheus/huagent_metrics_token" 2>/dev/null || true
  # 抓取目标：容器内服务端 api:8080；服务端跑在宿主机时用 host.docker.internal:8080
  cat >"$OBS_DIR/prometheus/targets/huagent-api.yml" <<EOF
# 由 scripts/quickstart.sh 生成（改完 30s 内自动生效，无需重启 Prometheus）
- targets: ["$target"]
  labels:
    instance: huagent-api
    env: quickstart
EOF
  # 告警路由：从模板渲染收件人与 SMTP
  sed -e "s|@SMTP_SMARTHOST@|$(env_get SMTP_SMARTHOST mailpit:1025)|" \
      -e "s|@SMTP_REQUIRE_TLS@|$(env_get SMTP_REQUIRE_TLS false)|" \
      -e "s|@ALERT_EMAIL_FROM@|$(env_get ALERT_EMAIL_FROM huagent-alerts@localhost)|" \
      -e "s|@ALERT_EMAIL_TO@|$(env_get ALERT_EMAIL_TO alerts@example.com)|" \
      "$template" >"$OBS_DIR/alertmanager/alertmanager.yml"
  chmod 600 "$OBS_DIR/alertmanager/alertmanager.yml" 2>/dev/null || true
}

cmd_monitoring() {
  local action="${1:-up}" with_logs=0
  shift || true
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --with-logs) with_logs=1; shift ;;
      --target) HUAGENT_METRICS_TARGET="$2"; shift 2 ;;
      *) fail "未知参数：$1" ;;
    esac
  done
  require_docker
  ensure_env_file

  case "$action" in
    up)
      ensure_env_var METRICS_TOKEN "$(random_secret)"
      ensure_env_var GRAFANA_ADMIN_PASSWORD "$(random_secret)"
      ensure_env_var ALERT_EMAIL_FROM huagent-alerts@localhost
      ensure_env_var ALERT_EMAIL_TO alerts@example.com
      ensure_env_var SMTP_SMARTHOST mailpit:1025
      ensure_env_var SMTP_REQUIRE_TLS false
      ensure_env_var HUAGENT_METRICS_TARGET api:8080
      if [[ -n "${HUAGENT_METRICS_TARGET:-}" ]]; then
        sed -i.bak "s|^HUAGENT_METRICS_TARGET=.*|HUAGENT_METRICS_TARGET=${HUAGENT_METRICS_TARGET}|" "$ENV_FILE"
        rm -f "$ENV_FILE.bak"
      fi
      ensure_observability_files
      banner "启动监控栈（Prometheus / Grafana / Alertmanager${with_logs:+ / Loki}）"
      local profiles=(--profile mail)
      [[ $with_logs -eq 1 ]] && profiles+=(--profile logs)
      local services=(prometheus alertmanager grafana mailpit)
      [[ $with_logs -eq 1 ]] && services+=(loki promtail)
      # 先重建 api 以加载 HUAGENT_METRICS_TOKEN，再起监控组件
      "${COMPOSE_ALL[@]}" "${profiles[@]}" up -d api
      "${COMPOSE_ALL[@]}" "${profiles[@]}" up -d "${services[@]}"
      sleep 3
      cmd_monitoring_status
      cat <<EOF

Grafana        http://localhost:$(env_get GRAFANA_PORT 3000)   用户 $(env_get GRAFANA_ADMIN_USER admin) / 口令见 .env.quickstart 的 GRAFANA_ADMIN_PASSWORD
Prometheus     http://localhost:$(env_get PROMETHEUS_PORT 9090)
Alertmanager   http://localhost:$(env_get ALERTMANAGER_PORT 9093)
告警收件箱      http://localhost:$(env_get MAILPIT_UI_PORT 8025)   （Mailpit；接企业邮箱改 .env.quickstart 后重跑本命令）
抓取目标        $(env_get HUAGENT_METRICS_TARGET api:8080)
EOF
      ;;
    down)
      "${COMPOSE_ALL[@]}" --profile mail --profile logs rm -sf prometheus alertmanager grafana mailpit loki promtail
      echo "监控栈已停止（业务服务与数据卷未受影响）"
      ;;
    status) cmd_monitoring_status ;;
    logs) "${COMPOSE_ALL[@]}" --profile mail --profile logs logs -f --tail=100 prometheus alertmanager grafana ;;
    *) fail "用法：scripts/quickstart.sh monitoring {up|down|status|logs} [--with-logs] [--target host:port]" ;;
  esac
}

cmd_monitoring_status() {
  local prometheus="http://127.0.0.1:$(env_get PROMETHEUS_PORT 9090)"
  local targets=""
  targets="$(curl -fsS "$prometheus/api/v1/targets" 2>/dev/null || true)"
  local scrape="", api=""
  if [[ -n "$targets" ]]; then
    if printf '%s' "$targets" | grep -q '"job":"hu-agent-api","health":"up"\\|"health":"up","job":"hu-agent-api"'; then
      scrape="UP"
    else
      scrape="DOWN（检查抓取目标与 METRICS_TOKEN 是否与 api 一致）"
    fi
    api="$targets"
  fi
  printf 'Prometheus   %s\n' "$(curl -fsS -o /dev/null -w '%{http_code}' "$prometheus/-/healthy" 2>/dev/null || echo '不可达')"
  printf 'Grafana      %s\n' "$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(env_get GRAFANA_PORT 3000)/api/health" 2>/dev/null || echo '不可达')"
  printf 'Alertmanager %s\n' "$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$(env_get ALERTMANAGER_PORT 9093)/-/healthy" 2>/dev/null || echo '不可达')"
  [[ -z "$api" ]] || printf 'hu-agent-api 抓取 %s\n' "$scrape"
  return 0
}

cmd_down() { require_docker; ensure_env_file; "${COMPOSE[@]}" down "$@"; }

cmd_reset() {
  require_docker
  ensure_env_file
  printf '[31m将删除本目录的数据卷（PostgreSQL/Redis/MinIO），数据不可恢复。[0m
'
  read -r -p "输入 yes 确认: " reply
  [[ "$reply" == "yes" ]] || fail "已取消"
  "${COMPOSE[@]}" down -v
  echo "已删除数据卷；下次 up 会重新初始化。"
}
cmd_logs() { require_docker; ensure_env_file; "${COMPOSE[@]}" logs -f --tail=200 "$@"; }

cmd_admin() {
  require_docker
  ensure_env_file
  "${COMPOSE[@]}" exec -T api huagent-admin "$@"
}

case "${1:-up}" in
  up) shift || true; cmd_up "$@" ;;
  down) shift || true; cmd_down "$@" ;;
  reset) shift || true; cmd_reset "$@" ;;
  logs) shift || true; cmd_logs "$@" ;;
  admin) shift || true; cmd_admin "$@" ;;
  monitoring) shift || true; cmd_monitoring "$@" ;;
  *) fail "用法：scripts/quickstart.sh {up|down|reset|logs|admin|monitoring} …" ;;
esac
