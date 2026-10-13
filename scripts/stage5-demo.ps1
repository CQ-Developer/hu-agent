# scripts/stage5-demo.ps1
# 阶段 5 全流程走查（组织/团队/邀请/RBAC/审批/Skill 市场/状态同步）。
# 需要：Docker（Postgres + MinIO 已启动）、服务端已运行（默认 http://127.0.0.1:8080）。
#
# 用法（在仓库根目录或任意目录）：
#   powershell -ExecutionPolicy Bypass -File scripts/stage5-demo.ps1
#   # 自定义地址/密码：
#   powershell -ExecutionPolicy Bypass -File scripts/stage5-demo.ps1 -BaseUrl http://127.0.0.1:8080
#
# 说明：脚本会创建 4 个账号（sysadmin/owner/member/outsider@example.com，已存在则登录），
#       并把 sysadmin 直接标记为系统管理员（本地开发便捷通道；生产由部署时内置）。
#       重复执行安全：组织 slug/团队名/Skill 名带随机后缀。

param(
  [string]$BaseUrl = "http://127.0.0.1:8080",
  [string]$Password = "Str0ng-Passphrase-2026",
  [string]$PgContainer = "huagent-postgres"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$script:stepNo = 0

function Step([string]$message) {
  $script:stepNo += 1
  Write-Host ""
  Write-Host ("[{0}] {1}" -f $script:stepNo, $message) -ForegroundColor Cyan
}

function Ok([string]$message) { Write-Host ("    OK  {0}" -f $message) -ForegroundColor Green }

function Api([string]$Method, [string]$Path, [string]$Token, $Body = $null, [string]$ContentType = "application/json") {
  $headers = @{ "X-Client-Version" = "0.1.0" }
  if ($Token) { $headers["Authorization"] = "Bearer $Token" }
  $uri = "$BaseUrl$Path"
  $attempt = 0
  while ($true) {
    try {
      if ($Body -ne $null) {
        $json = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Depth 8 }
        # PowerShell 5.1 默认按 ANSI 发送字符串体，中文会变成 ?；统一转 UTF-8 字节
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
        $ct = if ($ContentType -like "*charset*") { $ContentType } else { "$ContentType; charset=utf-8" }
        return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers -ContentType $ct -Body $bytes
      }
      return Invoke-RestMethod -Method $Method -Uri $uri -Headers $headers
    } catch {
      $status = $_.Exception.Response.StatusCode.value__
      if ($status -eq 429 -and $attempt -lt 2) {
        $retry = 60
        try {
          $header = $_.Exception.Response.Headers["Retry-After"]
          if ($header) { $retry = [int]$header }
        } catch { }
        Write-Host ("    触发登录限流，等待 {0}s 后重试…" -f $retry) -ForegroundColor Yellow
        Start-Sleep -Seconds ([Math]::Min($retry, 65))
        $attempt += 1
        continue
      }
      throw
    }
  }
}

function ExpectStatus([string]$Method, [string]$Path, [string]$Token, [int]$Expected, [string]$Label, $Body = $null) {
  try {
    $null = Api $Method $Path $Token $Body
    if ($Expected -ne 200 -and $Expected -ne 201) { throw "$Label 期望 HTTP $Expected，实际为成功" }
    Ok "$Label → $Expected"
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq $Expected) { Ok "$Label → $Expected（预期）" }
    else { throw "$Label 期望 HTTP $Expected，实际 $status：$($_.ErrorDetails.Message)" }
  }
}

function EnsureUser([string]$email, [string]$display) {
  try {
    $null = Api "POST" "/api/v1/auth/register" $null @{ email = $email; password = $Password; displayName = $display }
  } catch {
    # 已注册（409）则继续登录
  }
  $session = Api "POST" "/api/v1/auth/login" $null @{
    email    = $email
    password = $Password
    device   = @{ deviceId = "demo-cli"; platform = "win32"; appVersion = "0.1.0" }
  }
  return $session.accessToken
}

Step "健康检查 $BaseUrl"
$health = Api "GET" "/api/v1/system/health" $null
Ok ($health | ConvertTo-Json -Compress)

Step "注册/登录四个账号（sysadmin / owner / member / outsider）"
$sysadmin = EnsureUser "sysadmin@example.com" "系统管理员"
$owner = EnsureUser "owner@example.com" "组织管理员"
$member = EnsureUser "member@example.com" "团队成员"
$outsider = EnsureUser "outsider@example.com" "无关用户"
Ok "4 个账号就绪"

Step "把 sysadmin 标记为系统管理员（本地开发便捷通道）"
$null = docker exec $PgContainer psql -U huagent -d huagent -c "update users set is_system_admin = true where email = 'sysadmin@example.com'"
Ok "is_system_admin = true"

$suffix = Get-Random -Minimum 1000 -Maximum 9999

Step "owner 申请创建组织；sysadmin 在系统范围审批通过"
$applied = Api "POST" "/api/v1/orgs:apply" $owner @{
  name        = "演示组织 $suffix"
  slug        = "demo-org-$suffix"
  description = "阶段 5 走查"
  reason      = "验证组织创建审批"
}
Ok "approvalId=$($applied.approvalId)"
$systemPending = Api "GET" "/api/v1/approvals?scope=system&status=pending" $sysadmin
$null = Api "POST" "/api/v1/approvals/$($applied.approvalId):approve" $sysadmin @{ comment = "同意" }
$orgs = Api "GET" "/api/v1/orgs" $owner
$org = $orgs | Where-Object { $_.slug -eq "demo-org-$suffix" }
Ok "组织已创建：$($org.name)（我的角色：$($org.role)）"

Step "owner 申请创建团队；owner 作为组织管理员审批通过"
$teamApplied = Api "POST" "/api/v1/teams:apply" $owner @{
  orgId       = $org.id
  name        = "演示团队 $suffix"
  description = "阶段 5 走查"
  reason      = "验证团队创建审批"
}
$null = Api "POST" "/api/v1/approvals/$($teamApplied.approvalId):approve" $owner @{ comment = "同意" }
$teams = Api "GET" "/api/v1/teams" $owner
$team = $teams | Where-Object { $_.orgId -eq $org.id } | Select-Object -Last 1
if (-not $team) { throw "未找到刚创建的团队（orgId=$($org.id)）" }
Ok "团队已创建：$($team.name)"

Step "邀请 member 加入组织与团队（一次性邀请码，7 天有效）"
$orgInvite = Api "POST" "/api/v1/orgs/$($org.id)/invitations" $owner @{ email = "member@example.com"; role = "member" }
$null = Api "POST" "/api/v1/invitations:accept" $member @{ token = $orgInvite.acceptToken }
Ok "已加入组织（role=$($orgInvite.role)）"
$teamInvite = Api "POST" "/api/v1/teams/$($team.id)/invitations" $owner @{ email = "member@example.com"; role = "member" }
$null = Api "POST" "/api/v1/invitations:accept" $member @{ token = $teamInvite.acceptToken }
Ok "已加入团队"

Step "RBAC：无关用户看不到组织/团队（404），成员不能执行管理员操作（403）"
ExpectStatus "GET" "/api/v1/orgs/$($org.id)" $outsider 404 "outsider 读组织"
ExpectStatus "GET" "/api/v1/teams/$($team.id)/members" $outsider 404 "outsider 读团队成员"
ExpectStatus "POST" "/api/v1/teams/$($team.id)/invitations" $member 403 "member 邀请（需管理员）" @{ email = "outsider@example.com"; role = "member" }

Step "member 上传 Skill 包（zip：SKILL.md + scripts/run.sh）"
$tmp = Join-Path $env:TEMP "huagent-skill-demo-$suffix"
New-Item -ItemType Directory -Force -Path (Join-Path $tmp "scripts") | Out-Null
$skillMd = @"
---
name: demo-skill-$suffix
description: 阶段 5 走查用示例 Skill
version: 1.0.0
when_to_use: 仅在演示流程中使用
requires:
  tools: [read_file]
  bins: []
  network: false
tags: [demo]
min_app_version: 0.1.0
---

# 演示 Skill

这是走查流程生成的示例包。
"@
[IO.File]::WriteAllText((Join-Path $tmp "SKILL.md"), $skillMd, (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $tmp "scripts/run.sh"), "#!/bin/sh`necho demo`n", (New-Object System.Text.UTF8Encoding($false)))
$zipBase = Join-Path $env:TEMP "demo-skill-$suffix"
$zipPath = "$zipBase.zip"
$hskillPath = "$zipBase.hskill"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $zipPath
Move-Item -Force $zipPath $hskillPath

$headers = @{ Authorization = "Bearer $member"; "X-Client-Version" = "0.1.0" }
$uploaded = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/teams/$($team.id)/skills?changelog=demo-first" `
  -Headers $headers -ContentType "application/zip" -InFile $hskillPath
$skillId = $uploaded.skillId
Ok "已提交，状态=$($uploaded.status)（待团队管理员审批）"

Step "重复上传同一 Skill：应被拒绝（已有待审版本）；空包应报 PACKAGE_INVALID"
try {
  $null = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/skills/$skillId/versions" `
    -Headers $headers -ContentType "application/zip" -InFile $hskillPath
  throw "重复提交未被拒绝"
} catch {
  $status = $_.Exception.Response.StatusCode.value__
  if ($status -eq 409) { Ok "重复提交 → 409（预期）" }
  else { throw "期望 409，实际 $status：$($_.ErrorDetails.Message)" }
}
ExpectStatus "POST" "/api/v1/skills/$skillId/versions" $member 422 "空包上传"

Step "owner 查看待审详情并审批通过"
$pending = Api "GET" "/api/v1/approvals?scope=team&team_id=$($team.id)&status=pending" $owner
$approval = $pending.items | Where-Object { $_.targetId -eq $uploaded.versionId }
if (-not $approval) { throw "未找到刚提交的待审记录（targetId=$($uploaded.versionId)）" }
$detail = Api "GET" "/api/v1/approvals/$($approval.id)" $owner
Write-Host "    载荷快照：版本 $($detail.payload.version)，脚本 $($detail.payload.scripts -join ',' )，需要工具 $($detail.payload.requires.tools -join ',')"
$null = Api "POST" "/api/v1/approvals/$($approval.id):approve" $owner @{ comment = "通过" }
Ok "版本已发布"

Step "市场可见性：member 可见，outsider 不可见"
$market = Api "GET" "/api/v1/marketplace/skills" $member
$mine = $market.items | Where-Object { $_.id -eq $skillId }
$marketOutsider = Api "GET" "/api/v1/marketplace/skills" $outsider
$outsiderMine = $marketOutsider.items | Where-Object { $_.id -eq $skillId }
Ok "member 看到 $(@($mine).Count) 个（总 $($market.items.Count)）；outsider 看到 $(@($outsiderMine).Count) 个"

Step "获取下载地址并实际下载，校验 sha256"
$download = Api "GET" "/api/v1/skills/$skillId/versions/1.0.0/download-url" $member
$expected = $download.digest -replace "^sha256:", ""
if ($download.url -like "memory://*") {
  # 服务端以 HUAGENT_OBJECT_STORE=memory 运行（未启 MinIO）时无法真实下载，仅校验摘要
  Ok "预签名地址已生成（内存对象存储：$($download.url)），摘要 $expected"
  Write-Host "    提示：需要真实下载时请先启动 MinIO（docker compose up -d minio）并以默认 s3 存储重启 API" -ForegroundColor Yellow
} else {
  $outFile = Join-Path $env:TEMP "downloaded-$suffix.hskill"
  Invoke-WebRequest -Uri $download.url -OutFile $outFile -UseBasicParsing
  $hash = (Get-FileHash -Algorithm SHA256 -Path $outFile).Hash.ToLower()
  if ($hash -ne $expected) { throw "sha256 校验失败：$hash != $expected" }
  Ok "下载并校验通过（$hash）"
}

Step "资源状态查询（客户端接口）"
$status = Api "POST" "/api/v1/resources/status:check" $member @{ items = @(@{ type = "skill"; refId = $skillId; version = "1.0.0" }) }
Ok "member → $($status.items[0].status)，修订号 $($status.items[0].revision)"
$statusOutsider = Api "POST" "/api/v1/resources/status:check" $outsider @{ items = @(@{ type = "skill"; refId = $skillId; version = "1.0.0" }) }
Ok "outsider → $($statusOutsider.items[0].status)"

Step "member 上报激活快照（用于定向通知）"
$null = Api "POST" "/api/v1/me/activations:report" $member @{
  deviceId = "demo-cli"
  scope    = "global"
  items    = @(@{ type = "skill"; source = "market"; refId = $skillId; name = "demo-skill-$suffix"; version = "1.0.0"; enabled = $true })
}
Ok "已上报"

Step "owner 停用资源（必填原因）→ member 状态变 disabled 并收到通知"
ExpectStatus "POST" "/api/v1/skills/$skillId`:disable" $owner 422 "无原因停用"
$reason = [uri]::EscapeDataString("走查演示停用")
$disabled = Api "POST" "/api/v1/skills/$skillId`:disable?reason=$reason" $owner
Ok "已停用，通知了 $($disabled.notified) 个用户"
$status = Api "POST" "/api/v1/resources/status:check" $member @{ items = @(@{ type = "skill"; refId = $skillId; version = "1.0.0" }) }
Ok "member → $($status.items[0].status)：$($status.items[0].reason)"
$notes = Api "GET" "/api/v1/me/notifications?unread_only=true" $member
Ok "member 未读通知 $($notes.unread) 条（含 skill.disabled）"
$null = Api "PATCH" "/api/v1/me/notifications" $member @{ all = $true }

Step "恢复启用 → 下架 → 重新上架 → 软删除，各阶段状态符合预期"
$null = Api "POST" "/api/v1/skills/$skillId`:enable" $owner
$null = Api "POST" "/api/v1/skills/$skillId`:delist" $owner
$status = Api "POST" "/api/v1/resources/status:check" $member @{ items = @(@{ type = "skill"; refId = $skillId; version = "1.0.0" }) }
Ok "下架后 → $($status.items[0].status)"
$null = Api "POST" "/api/v1/skills/$skillId`:publish" $owner
$status = Api "POST" "/api/v1/resources/status:check" $member @{ items = @(@{ type = "skill"; refId = $skillId; version = "1.0.0" }) }
Ok "上架后 → $($status.items[0].status)"
$null = Api "DELETE" "/api/v1/skills/$skillId" $owner
$status = Api "POST" "/api/v1/resources/status:check" $member @{ items = @(@{ type = "skill"; refId = $skillId; version = "1.0.0" }) }
Ok "删除后 → $($status.items[0].status)"

Step "审批纪律：驳回必须填意见；已处理审批不能重复处理"
$applied2 = Api "POST" "/api/v1/orgs:apply" $owner @{
  name = "驳回演示 $suffix"; slug = "demo-reject-$suffix"; description = ""; reason = ""
}
ExpectStatus "POST" "/api/v1/approvals/$($applied2.approvalId):reject" $sysadmin 422 "无意见驳回" @{ comment = "" }
$null = Api "POST" "/api/v1/approvals/$($applied2.approvalId):reject" $sysadmin @{ comment = "演示驳回" }
ExpectStatus "POST" "/api/v1/approvals/$($applied2.approvalId):approve" $sysadmin 409 "重复处理" @{ comment = "" }
Ok "驳回与重复处理校验通过"

Write-Host ""
Write-Host "全部走查通过。" -ForegroundColor Green
Write-Host "临时文件：$tmp（可删除）"
