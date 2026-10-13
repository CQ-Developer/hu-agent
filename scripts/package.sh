#!/usr/bin/env bash
# 打包与签名（Linux/macOS 上用；Windows 见 scripts/package.ps1）。
#
# 用法：
#   scripts/package.sh               # 按当前平台打包（macOS 出 dmg，Linux/Windows 需在对应平台执行）
#   scripts/package.sh --mac         # 强制 macOS 目标（仅 macOS 可用）
#   scripts/package.sh --linux       # 仅构建，不签名
#
# 签名环境变量（详见 docs/delivery/signing.md）：
#   Windows: CSC_LINK（.pfx 路径或 base64）、CSC_KEY_PASSWORD
#   macOS：  CSC_LINK/.p12 + CSC_KEY_PASSWORD，公证另需 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-auto}"
cd app

if [[ ! -d node_modules ]]; then
  echo "安装依赖…"
  npm ci
fi

EXTRA_ARGS=()
case "$TARGET" in
  --mac)
    if [[ "$(uname -s)" != "Darwin" ]]; then
      echo "macOS 目标只能在 macOS 上构建" >&2
      exit 1
    fi
    if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
      echo "检测到公证凭据：启用 mac.notarize"
      EXTRA_ARGS+=(--config.mac.notarize=true)
    else
      echo "未检测到 APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID：跳过公证（企业内部分发需自行评估 Gatekeeper 策略）"
    fi
    npm run build
    npx electron-builder --mac "${EXTRA_ARGS[@]}"
    ;;
  --linux)
    npm run build
    npx electron-builder --linux
    ;;
  auto)
    npm run build
    if [[ "$(uname -s)" == "Darwin" ]]; then
      if [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
        EXTRA_ARGS+=(--config.mac.notarize=true)
      fi
      npx electron-builder --mac "${EXTRA_ARGS[@]}"
    else
      npx electron-builder --linux
    fi
    ;;
  *)
    echo "未知参数：$TARGET" >&2
    exit 1
    ;;
esac

echo "生成校验和（sha256）…"
cd dist
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum ./*.dmg ./*.AppImage ./*.exe ./*.zip 2>/dev/null > SHA256SUMS.txt || true
else
  shasum -a 256 ./*.dmg ./*.AppImage ./*.exe ./*.zip 2>/dev/null > SHA256SUMS.txt || true
fi

echo ""
echo "产物："
ls -lh ./*.dmg ./*.AppImage ./*.exe ./*.zip 2>/dev/null || ls -lh . | head
echo ""
if [[ -s SHA256SUMS.txt ]]; then
  echo "校验和已写入 app/dist/SHA256SUMS.txt："
  cat SHA256SUMS.txt
fi

echo ""
echo "签名校验（按需）："
echo "  Windows: signtool verify /pa /v <installer>.exe"
echo "  macOS:   codesign --verify --deep --strict --verbose=2 \"hu-agent.app\" && spctl -a -vv \"hu-agent.app\""
echo "  macOS 公证日志: xcrun notarytool log <submission-id> --apple-id \"\$APPLE_ID\" --team-id \"\$APPLE_TEAM_ID\""
