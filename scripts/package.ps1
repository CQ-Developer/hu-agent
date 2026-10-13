# 打包与签名（Windows PowerShell）
#
# 用法（仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts/package.ps1
#
# 代码签名（可选，见 docs/delivery/signing.md）：
#   $env:CSC_LINK = 'C:\certs\hu-agent.pfx'      # 或 base64
#   $env:CSC_KEY_PASSWORD = '<pfx 密码>'
# 未配置时输出未签名安装包，并在结尾提示企业分发策略影响。
set -euo pipefail

Push-Location (Join-Path $PSScriptRoot '..')
try {
  Push-Location app
  if (-not (Test-Path node_modules)) {
    Write-Host '安装依赖…'
    npm ci
  }

  Write-Host '构建渲染层与主进程…'
  npm run build

  Write-Host '打包 Windows 安装包…'
  npx electron-builder --win

  Push-Location dist
  Write-Host ''
  Write-Host '生成校验和（sha256）…'
  Get-ChildItem -File -Include *.exe, *.zip, *.blockmap -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike '*unpacked*' } |
    ForEach-Object { "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLower(), $_.Name } |
    Set-Content -Encoding ascii SHA256SUMS.txt

  Write-Host ''
  Write-Host '产物：'
  Get-ChildItem -File *.exe, *.zip -ErrorAction SilentlyContinue | Format-Table Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }

  if (Test-Path SHA256SUMS.txt) {
    Write-Host ''
    Write-Host '校验和（app/dist/SHA256SUMS.txt）：'
    Get-Content SHA256SUMS.txt
  }

  Write-Host ''
  if ($env:CSC_LINK) {
    $signtool = Get-Command signtool -ErrorAction SilentlyContinue
    if ($signtool) {
      Get-ChildItem -File *.exe | ForEach-Object {
        Write-Host ("校验签名：{0}" -f $_.Name)
        signtool verify /pa /v $_.FullName
      }
    } else {
      Write-Host '未找到 signtool：请在带 Windows SDK 的机器上执行签名校验'
    }
  } else {
    Write-Host '未配置 CSC_LINK：输出为未签名安装包；企业分发前请完成代码签名（见 docs/delivery/signing.md）'
  }
  Pop-Location
} finally {
  Pop-Location
}
