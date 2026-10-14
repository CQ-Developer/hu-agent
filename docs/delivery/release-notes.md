# 发布说明（v0.1.0）

> 交付对象：企业内部（客户端桌面端 + 服务端 + 管理台）。
> 完整清单与证据见 `docs/delivery/release-checklist.md`；本文面向最终用户与运维。

## 1. 交付内容

| 组件 | 说明 |
| --- | --- |
| `hu-agent-app` | Windows / macOS 桌面客户端：Agent 循环、内置工具、Skill、MCP、市场、云同步、用量统计、权限与审计、诊断包 |
| `hu-agent-management` | 服务端：账号/组织/团队/RBAC/审批/市场/同步/统计/SSO/审计/通知，FastAPI + PostgreSQL 18 + Redis + S3 兼容对象存储 |
| `hu-agent-management-ui` | 管理台（阶段 A）：登录、审批、Skill 审核与生命周期、成员与邀请、身份源（SSO）管理、个人设置 |
| 文档 | `docs/delivery/`：部署、运维、监控、性能、签名、安全评审、验收脚本、发布清单 |
| 脚本 | `scripts/`：依赖起停、DDL 应用、演示走查、安全扫描、性能基准、SSO 联调、CI 种子 |

## 2. 平台与依赖

- 客户端：Windows 10/11 x64、macOS 12+（Apple Silicon / Intel）；需可访问服务端（HTTPS 建议）。
- 服务端：Linux（推荐）或 Windows + Docker；PostgreSQL 18、Redis 7、S3 兼容对象存储（MinIO 需本地源码构建，见 `docs/delivery/deployment.md`）、可选 Keycloak 26+。
- 数据库：DDL 脚本 `V0001`–`V0005`（应用启动只校验版本，不自动迁移）。

## 3. 重要行为说明（务必先读）

1. **必须登录才能使用客户端**（ADR 0004 / D16）：
   - 无离线宽限期；**服务端不可达时只能重试连接，不能进入应用**（企业身份管控要求）。
   - 客户端会保留本地登录态（密钥库加密），服务恢复后可直接重试；会话被撤销/账号被禁用时自动退回登录页。
2. **模型与 MCP 密钥只存在客户端**：写入系统密钥库（Windows DPAPI / macOS Keychain 保护），服务端不接收。
3. **用量上报不含隐私**：仅模型、token、耗时、状态、设备标识与会话哈希（盐值本地随机）；**不含提示词、回复、文件路径与工具参数**。
4. **云同步为整体快照**（不做文件级合并）：冲突时**不自动覆盖**，提供「保留本地副本后覆盖 / 导出差异清单 / 取消」三选项。
5. **市场资源受服务端状态管控**：`实际启用 = 用户意图 ∧ 服务端状态`；停用/撤回/删除会硬停用并显示原因，恢复后按原意图自动恢复。
6. **账号注销**：个人中心「数据与隐私」→ 注销（需邮箱确认）；立即停用并撤销全部会话，**30 天后**清理账号信息（邮箱、昵称、身份绑定、设备、通知），用量统计改为匿名保留；**此操作不可自助撤销**，宽限期内需运维恢复。
7. **本地文件不随账号删除**：注销后请自行清理工作空间目录与 `~/.hu-agent`。

## 4. 安装与升级

- 安装：运行企业分发的安装包（Windows `.exe` / macOS `.dmg`）；首次启动进入登录门禁。
- 服务端升级：先执行 DDL（`scripts/ci/apply-ddl.py`，只升不降）→ 重启 API → 重启 worker（启动即补偿聚合与分区维护）。
- 客户端升级与回滚：安装包覆盖安装即可（用户数据在工作空间与 `~/.hu-agent`，不迁移）；回滚见 `docs/delivery/signing.md` 第 3 节。

## 5. 已知限制（v0.1.0）

| 类别 | 限制 | 计划 |
| --- | --- | --- |
| 管理台 | 阶段 A：仅审批、Skill 治理、成员与邀请、身份源、个人设置；组织/团队 CRUD、统计图表、通知中心、审计日志、系统设置、管理台 SSO 登录未做 | 阶段 B |
| 安装包 | 未签名（缺企业代码签名证书）：Windows SmartScreen 会提示未知发布者，部分 EDR 可能拦截 | 企业提供证书后按 `docs/delivery/signing.md` 签名 |
| 监控 | 指标端点与 12 条告警规则已就绪；Prometheus/Grafana 接入、Alertmanager 接收器与值班表需企业提供 | 企业侧接入 |
| 性能 | 仅有单机基线（见 `docs/delivery/performance.md`）；生产容量需在 staging 按目标拓扑复测 | 上线前完成 |
| 通知/邮件 | 站内通知已按收件人语言渲染；**邮件通道未实现**（邀请以邀请码形式交付） | 按需 |
| MCP | stdio 与 http/sse 传输：v1 实现了 stdio；http/sse 为路线图 3-05；MCP 市场（5-08）未做 | 后续版本 |
| 定时同步 | 冲突时自动暂停，需人工处理（不做自动合并） | 设计如此 |
| macOS | 未在真实 macOS 机器上做端到端验证（单测覆盖路径/保留名/UNC/符号链接） | 建议发布前实机验证 |

## 6. 排障入口

- 客户端：个人中心（服务端/设备/用量）→「关于」→ 导出诊断包（自动脱敏）。
- 服务端：`/api/v1/system/health`、`/ready`、`/metrics`；`X-Trace-Id` 关联日志；worker 任务见 `job_runs`。
- 常见问题：`docs/delivery/operations.md` 第 2–3 节（登录限流、市场停用、同步冲突、MCP 连接等）。

## 7. 验收与回归

- 演示脚本与确认表：`docs/delivery/acceptance.md`（含前置环境、10 分钟级场景、确认表）。
- 自动回归：`bash scripts/check-all.sh`、`HUAGENT_TESTCONTAINERS=1 uv run --project management pytest -m integration -q`、
  `cd app && CLOUD_E2E=1 MARKET_E2E=1 SYNC_E2E=1 STATS_E2E=1 npx vitest run tests/integration`；
  CI 每次推送执行上述内容 + 真实 S3 + 真实 IdP 冒烟（`.github/workflows/ci.yml`）。
