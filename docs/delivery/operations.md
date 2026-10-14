# 运维手册

## 1. 健康检查与监控

| 端点 | 用途 | 建议告警 |
| --- | --- | --- |
| `GET /api/v1/system/health` | 进程存活 | 连续 2 次失败 → P1 |
| `GET /api/v1/system/ready` | PG/Redis 就绪（schema 版本校验在启动时执行） | 失败 5 分钟 → P1 |
| `GET /api/v1/system/metrics` | Prometheus 指标（默认启用；`HUAGENT_METRICS_TOKEN` 可要求 Bearer 令牌） | 规则、看板与采集配置见 `docs/delivery/monitoring.md` |
| `GET /api/v1/stats/usage?scope=global` | 全局用量（系统管理员） | 突增/突降 50% → P3 观察 |

日志：API/worker 输出到 stdout（容器/systemd 收集）；结构化字段：`traceId`（`X-Trace-Id` 透传或自动生成，
响应头同样返回），排障时以 traceId 关联一次请求的全部日志。

worker 任务：`job_runs` 表记录**每个任务最近一次**执行（`job_id/status/started_at/finished_at/error`），
并通过 `huagent_job_last_*` 指标暴露（陈旧/失败告警见 `monitoring.md`）。
建议监控 `status='failed'` 与 `started_at` 超过 2 倍周期的任务。

## 2. 客户端排障

| 现象 | 排查 |
| --- | --- |
| 登录后立刻回到登录页 | 服务端撤销了会话（设备吊销/身份源禁用/refresh 重放）；看客户端日志与 `audit_logs` |
| 市场/同步/上报不工作 | 个人中心 → 云同步/待上报数；确认服务端可达、版本未被下架/停用 |
| 同步冲突 | 云同步 Tab 三个选项：保留本地副本后覆盖 / 导出差异 / 取消；冲突期间定时同步自动暂停 |
| MCP 工具不出现 | MCP 配置 → 测试连接；看错误与 stderr 末尾；`npx` 首次拉包可能较慢（握手超时 60s） |
| 客户端打不开（强制登录） | 设计如此（ADR 0004）：服务端不可达只提供重试；确认反向代理与证书 |

**诊断包**：客户端「关于」→「导出诊断包」。包含日志（10MB × 5 滚动）、本地配置、工作空间审计；
**不含密钥库**，且密钥字段统一替换为 `***`、主目录替换为 `~`。请让用户直接提供该 zip。

## 3. 常见告警与处置

| 告警 | 处置 |
| --- | --- |
| 登录限流频繁触发 | 先看 `huagent_login_attempts_total`：`result=failure` 集中同一 IP → 可能暴力尝试（`audit_logs` 中 `auth.login`）；`result=locked_ip` 且失败少 → 多为**办公室 NAT 共享出口 IP**，按 `performance.md` 第 4 节调整 `LOGIN_IP_LIMIT` |
| `QUOTA_EXCEEDED` 增多 | 查看 `GET /workspaces/{id}/quota`；调整 `system_settings.quota.user_bytes/team_bytes` 或引导用户配置 `syncExclude` |
| 快照上传超时残留 | worker `snapshot.cleanup` 会将 24h 未完成的 `uploading` 置 `aborted` 并删对象 |
| object store 不可达 | `/ready` 不检查 S3；以 Skill 上传/同步报错为准；检查 MinIO 容器与桶权限 |
| 用量上报积压 | 客户端队列按 1m/5m/30m/2h 退避；服务端看 `/usage:batch` 5xx 与 `usage_events` 写入速率 |

## 4. 数据保留与合规

| 数据 | 默认 | 调整 |
| --- | --- | --- |
| 原始用量事件 | 90 天（按月分区，worker 每日 DETACH 过期分区） | `system_settings.usage.retention_days` |
| 快照版本 | 最近 20 个（pinned 不计入） | `system_settings.snapshot.retention` |
| 审计日志 | 不自动删除（按企业保留策略手工归档） | 见 design 6.10.5 |
| 客户端本地日志 | 10MB × 5 | 客户端内部常量 |
| 站内通知 | 不自动删除 | 按收件人语言在**写入时**渲染（改语言不影响历史通知） |
| 日聚合用量 | 730 天（`usage.daily_retention_days`） | worker `usage.daily.prune` 每日 04:30 |
| 注销账号 PII | 宽限期 30 天后清理（`account.deletion_grace_days`） | worker `user.purge` 每日 04:00 |

### 4.1 数据主体请求（导出 / 注销）

- **用户自助**：客户端「个人中心 → 数据与隐私」可导出本人数据（JSON）与申请注销。
- **注销流程**：申请后账号立即停用、全部会话撤销（用户无法再登录）；宽限期后 worker 自动清理：
  邮箱/昵称/头像/密码、设备、身份绑定、通知、激活上报、个人工作空间与快照对象一律删除；
  `usage_events`/`usage_daily` 的 `user_id` 改挂匿名占位，**历史统计不断**；审计保留。
- **宽限期内恢复**（运维手工，需审批留痕）：

  ```sql
  -- 恢复被误注销的账号（仅宽限期内有效）
  UPDATE users SET status = 'active', deletion_requested_at = NULL, updated_at = now()
  WHERE email = '<user@example.com>' AND purged_at IS NULL;
  ```

  已 `purged_at` 的账号不可恢复（PII 已删除且不可逆）。
- **手动触发一次清理**（排查用）：

  ```bash
  uv run python -c "import asyncio; from huagent.common.runtime import new_event_loop;     from huagent.worker.jobs import run_job, purge_deleted_users;     print(asyncio.run(run_job('user.purge', purge_deleted_users), loop_factory=new_event_loop))"
  ```

- **日志卫生**（design 6.10.5）：服务端不接收提示词/回复/文件路径；令牌只存哈希；
  审计记录使用 id 而非明文；客户端日志与诊断包已脱敏（见第 2 节）。

## 5. 升级流程

1. 备份 PG（快照或 WAL 位点）与对象存储版本；
2. 执行 `uv run --project management huagent-admin db-migrate`（只升不降、幂等）；
3. 滚动重启 API → worker（worker 启动会先补偿聚合与分区维护）；
4. 冒烟：健康检查、登录、`POST /usage:batch`、市场列表、一次快照 init/complete、`GET /api/v1/system/metrics`；
5. 出现问题时按 `docs/delivery/signing.md` 第 3 节回滚客户端；服务端回滚走数据库恢复（DDL 无向下迁移）。

## 6. CI 端到端作业

`.github/workflows/ci.yml` 的 `e2e` 作业每次提交都会：构建 MinIO 镜像 → 起 PG/Redis/API →
种子数据 → 跑客户端 4 条端到端（登录上报 / 市场安装 / 云同步 / 统计）→ 起 Keycloak 跑真实 SSO 联调。
失败时自动输出 API、MinIO、Keycloak 日志。发布前以该作业绿线为准。
