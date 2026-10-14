# 安全策略

> English: [SECURITY.md](SECURITY.md)

## 支持范围

| 版本 | 支持情况 |
| --- | --- |
| `0.1.x`（当前） | 接受漏洞报告并按下面的时限处理 |
| 更早或未打标签的快照 | 不建议在生产使用，请先升级 |

自托管部署的安全基线见 [`docs/delivery/deployment.md`](docs/delivery/deployment.md)：
必须自行提供 `HUAGENT_JWT_SECRET` 与 `HUAGENT_MASTER_KEY`（非 local 环境缺省会拒绝启动）、
启用 TLS、按最小权限配置对象存储，并开启 `HUAGENT_RATE_LIMIT_STRICT`。

## 私密上报漏洞

请通过 GitHub Security Advisory 私密上报（仓库 → Security → *Report a vulnerability*），
或在无法使用时邮件联系维护者（见仓库主页）。

请尽量包含：

- 受影响的版本/提交、部署方式（容器/裸机、是否启用 SSO）；
- 复现步骤或最小 PoC（请勿包含真实用户数据与企业密钥）；
- 影响评估（越权、数据泄露、RCE、拒绝服务等）与你的联系方式；
- 若已知缓解方式，也请一并说明。

## 我们的处理时限（尽力而为）

| 阶段 | 目标 |
| --- | --- |
| 确认收到 | 3 个工作日内 |
| 初评与严重度判断 | 7 个工作日内 |
| 修复或缓解建议 | 严重问题 30 天内给出修复或缓解方案 |
| 公开披露 | 与报告者协商；修复发布后默认在 CHANGELOG 与 Release 中致谢（可匿名） |

## 范围说明

**属于漏洞**：认证/授权绕过、越权访问他人数据、SSRF/路径逃逸、注入、令牌/密钥泄露、
上传包解析类漏洞（zip 逃逸、炸弹、反斜杠走私）、审计绕过、限流缺失导致的账号爆破。

**不属于漏洞**（请按普通 issue 反馈）：

- 需要已经拿到宿主机 root/管理员权限的攻击场景；
- 未启用 TLS、使用了示例密钥、把服务直接暴露在公网等**部署配置**问题；
- 客户端本地文件被本机其他用户读取（工作空间文件本身即用户数据，依赖操作系统权限保护）；
- 依赖项的既有 CVE——请先看 `scripts/security-scan.sh` 结果与我们记录的豁免说明（`docs/delivery/security-review.md`），
  若确实影响本项目使用方式，欢迎附利用路径上报。

## 加固建议（面向部署方）

1. 数据库/Redis/对象存储不要暴露到公网；只暴露 API，并在前面加 TLS 反向代理。
2. 定期执行 `bash scripts/security-scan.sh`；关注 GitHub Actions 的 `security` 作业结果。
3. 开启审计留档（`audit_logs`）并按企业保留策略归档；数据主体请求按 `docs/delivery/operations.md` 4.1 处理。
4. 生产开启 SSO 并关闭自助注册（`HUAGENT_AUTH_REGISTRATION_ENABLED=false`）。
5. 使用 `docs/delivery/monitoring.md` 的告警规则监控登录失败、5xx、worker 任务新鲜度。
