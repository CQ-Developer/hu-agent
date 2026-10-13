# 打包与代码签名（Windows / macOS）

> 交付要求（附录 E）：**Windows / macOS 签名安装包，升级与回滚验证通过**。
> 本文档记录证书准备、构建命令、校验方法与升级/回滚注意事项；证书与私钥不在仓库内。

## 1. Windows（Authenticode / NSIS）

### 1.1 证书准备

| 类型 | 适用 | 说明 |
| --- | --- | --- |
| OV 代码签名证书 | 一般内部分发 | 企业 CA 或公共 CA 签发，`.pfx` + 密码 |
| EV 代码签名证书 | 需要立刻建立 SmartScreen 信誉 | 通常绑定硬件令牌/HSM，改用自定义签名钩子 |
| 企业内网 CA 自签 | 仅内网、配合组策略信任链 | 需在终端预置根证书 |

- 私钥不出企业环境：CI/打包机使用专用签名证书或 HSM，不要把 `.pfx` 提交到仓库；
- 时间戳服务器：`http://timestamp.digicert.com`（已写入 `app/electron-builder.yml`，保证签名长期有效）。

### 1.2 构建命令

```powershell
# 在仓库根目录（Git Bash 或 PowerShell 均可执行对应脚本）
$env:CSC_LINK = 'C:\certs\hu-agent.pfx'      # 也可以是 base64 字符串
$env:CSC_KEY_PASSWORD = '<pfx 密码>'
powershell -ExecutionPolicy Bypass -File scripts/package.ps1
# 或（git bash / CI）
CSC_LINK=/secure/hu-agent.pfx CSC_KEY_PASSWORD=*** bash scripts/package.sh --win
```

产物：`app/dist/hu-agent Setup <version>.exe`、`app/dist/SHA256SUMS.txt`。

### 1.3 校验

```powershell
signtool verify /pa /v "app\dist\hu-agent Setup 0.1.0.exe"
Get-AuthenticodeSignature "app\dist\hu-agent Setup 0.1.0.exe" | Format-List Status, SignerCertificate
```

预期：`Status = Valid`，签名者为证书主体；未签名时为 `NotSigned`（见 1.4）。

### 1.4 未签名构建的后果（必须如实告知）

- SmartScreen 首次运行会提示"未知发布者"；
- 部分 EDR/组策略会直接拦截未签名安装包；
- 升级仍在应用内进行（校验签名与版本），但企业 MDM 可能不认。

因此**发布到企业前必须完成签名**，并在交付记录里保存证书指纹（`Get-FileHash` 与 `certutil -dump` 输出各一份）。

## 2. macOS（Developer ID + 公证）

### 2.1 证书与账号

- 证书：`Developer ID Application`（.p12 导出）与 `Developer ID Installer`（如打 pkg）；
- 公证：Apple ID（建议企业 App Store Connect 专用账号）+ App 专用密码 + Team ID；
- 环境变量（electron-builder 约定）：

```bash
export CSC_LINK=/secure/hu-agent-developer-id.p12
export CSC_KEY_PASSWORD='***'
export APPLE_ID='ci@example.com'
export APPLE_APP_SPECIFIC_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='ABCDE12345'
```

### 2.2 构建命令

```bash
bash scripts/package.sh --mac
# 脚本检测到 APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID 时自动启用 --config.mac.notarize=true
```

`app/electron-builder.yml` 已启用 Hardened Runtime 并引用 `app/build/entitlements.mac.plist`
（Electron 需要的 JIT 与网络权限，无额外特权）。

### 2.3 校验

```bash
codesign --verify --deep --strict --verbose=2 "app/dist/mac/hu-agent.app"
spctl -a -vv "app/dist/mac/hu-agent.app"          # 期望 accepted, source=Developer ID
xcrun stapler validate "app/dist/hu-agent.dmg"    # 期望 The validate action worked
```

## 3. 升级与回滚

| 场景 | 行为 |
| --- | --- |
| Windows 覆盖安装 | NSIS 默认保留用户数据（`~/.hu-agent` 与工作空间无关）；安装目录可自定义 |
| 会话/工作空间数据 | 全部在用户目录与工作空间内，升级不迁移；`db/ddl` 只升不降（服务端） |
| 回滚客户端 | 卸载当前版本后安装旧版本安装包；若新版本已写入 `session_options`/`sync state` 等新字段，旧版本会忽略未知字段（JSONL 只追加） |
| 回滚服务端 | 使用 `db/rollback/R*.sql` **仅在测试环境**；生产回滚走数据库快照恢复（DDL 不做向下迁移） |

## 4. 发布记录模板（建议附在交付文档）

```text
版本：v0.1.0
构建提交：<git sha>
构建时间/机器：<...>
Windows 安装包：hu-agent Setup 0.1.0.exe  sha256=<...>
 签名指纹：<cert thumbprint>  时间戳：<ts>
macOS：hu-agent-0.1.0.dmg  sha256=<...>
 公证 submission id：<...>
冒烟 E2E：CI e2e 作业通过（链接）
已知问题：<...>
```
