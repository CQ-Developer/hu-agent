#!/usr/bin/env bash
# 按编号顺序执行 db/ddl/V*.sql 中尚未应用的脚本，并记录到 schema_versions。
# 依赖：docker compose 的 postgres 服务正在运行；DDL 文件末尾自带 schema_versions 写入。
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE_FILE="docker/compose.yaml"
PG_SERVICE="postgres"
PG_USER="${PG_USER:-huagent}"
PG_DB="${PG_DB:-huagent}"

if ! docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx "$PG_SERVICE"; then
  echo "postgres 未运行，请先执行: scripts/dev-deps.sh up" >&2
  exit 1
fi

psql() {
  docker compose -f "$COMPOSE_FILE" exec -T "$PG_SERVICE" \
    psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 "$@"
}

applied=0
shopt -s nullglob
for file in db/ddl/V*.sql; do
  version="$(basename "$file" | cut -d_ -f1)"
  checksum="$(sha256sum "$file" | cut -d' ' -f1)"

  if [ "$(psql -tAc "SELECT to_regclass('public.schema_versions') IS NOT NULL" | tr -d '\r')" = "t" ]; then
    if [ "$(psql -tAc "SELECT count(*) FROM schema_versions WHERE version = '${version}'" | tr -d '\r')" != "0" ]; then
      echo "跳过 ${version}（已应用）"
      continue
    fi
  fi

  echo "应用 ${file} ..."
  psql <"$file" >/dev/null
  psql -c "UPDATE schema_versions SET checksum = 'sha256:${checksum}' WHERE version = '${version}'" >/dev/null
  applied=$((applied + 1))
done

echo "完成：本次应用 ${applied} 个脚本"
psql -c "SELECT version, description, checksum, applied_at FROM schema_versions ORDER BY version"
