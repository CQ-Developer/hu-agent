#!/usr/bin/env bash
# 依赖与静态扫描（本地与 CI 同源）。发布前必须全绿（附录 E）。
#
#   bash scripts/security-scan.sh            # 严格模式：任一项发现问题即失败
#   bash scripts/security-scan.sh --report   # 额外打印含开发依赖的完整 npm audit（不阻断）
#
# 工具通过 uvx/npx 临时运行，不写入项目依赖。CI 使用固定版本以保证可复现。
set -euo pipefail
cd "$(dirname "$0")/.."


PIP_AUDIT_VERSION="${PIP_AUDIT_VERSION:-2.10.1}"
BANDIT_VERSION="${BANDIT_VERSION:-1.9.4}"

echo "==> Python 依赖漏洞扫描（pip-audit ${PIP_AUDIT_VERSION}）"
REQS="$(mktemp -t huagent-reqs-XXXXXX.txt)"
trap 'rm -f "$REQS"' EXIT
(cd management && uv export --format requirements-txt --no-hashes --no-emit-project -o "$REQS" >/dev/null)
# 自身包不在 PyPI，pip-audit 会跳过（提示 Skip Reason），不影响结论
uvx --from "pip-audit==${PIP_AUDIT_VERSION}" pip-audit -r "$REQS"

echo ""
echo "==> Python 静态扫描（bandit ${BANDIT_VERSION}，只报 medium 及以上）"
uvx --from "bandit==${BANDIT_VERSION}" bandit -r management/src -ll -q

echo ""
echo "==> 前端生产依赖扫描（npm audit --omit=dev）"
(cd app && npm audit --omit=dev)
(cd management-ui && npm audit --omit=dev)

if [[ "${1:-}" == "--report" ]]; then
  echo ""
  echo "==> 完整依赖扫描（含开发依赖，仅报告不阻断）"
  echo "--- app ---"
  (cd app && npm audit) || echo "（app 开发依赖存在告警：见 docs/delivery/security-review.md 豁免说明）"
  echo "--- management-ui ---"
  (cd management-ui && npm audit) || true
fi

echo ""
echo "安全扫描全部通过（生产依赖与源码静态扫描无 medium 及以上问题）"
