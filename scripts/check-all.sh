#!/usr/bin/env bash
# 提交前的一键检查：能跑什么就跑什么，缺工具链时给出提示而不是失败。
set -uo pipefail
cd "$(dirname "$0")/.."

failed=0
run() {
  local name="$1"; shift
  echo ""
  echo "==> ${name}"
  if "$@"; then
    echo "    ok"
  else
    echo "    FAILED: ${name}"
    failed=1
  fi
}

# 服务端（Python 3.14 + uv）
if [ -f management/pyproject.toml ] && command -v uv >/dev/null 2>&1; then
  if [ -f management/uv.lock ]; then
    run "服务端 lint / mypy / pytest" bash -c "cd management && uv run ruff check . && uv run mypy src && uv run pytest -q"
  else
    echo "[跳过] 服务端：尚未生成 uv.lock，请先执行: cd management && uv sync"
  fi
else
  echo "[跳过] 服务端：management/pyproject.toml 不存在或 uv 未安装"
fi

# 客户端（有 package.json 才跑）
if [ -f app/package.json ] && command -v npm >/dev/null 2>&1; then
  run "客户端 lint/测试/构建" bash -c "cd app && npm run --if-present check"
else
  echo "[跳过] 客户端：app/package.json 不存在或 npm 未安装"
fi

# 管理台
if [ -f management-ui/package.json ] && command -v npm >/dev/null 2>&1; then
  run "管理台 lint/测试/构建" bash -c "cd management-ui && npm run --if-present check"
else
  echo "[跳过] 管理台：management-ui/package.json 不存在或 npm 未安装"
fi

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "存在失败项"
  exit 1
fi
echo ""
echo "全部通过（或已跳过缺失工具链）"
