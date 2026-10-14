# 监控与告警（Prometheus）

客户端是桌面应用，无法被 Prometheus 抓取；其运行状况通过**用量上报**进入服务端，因此监控以服务端
（API + worker + 数据库）为唯一采集目标。本文档给出端点、采集配置、告警规则与看板查询。

## 1. 指标端点

`GET /api/v1/system/metrics`（Prometheus 文本格式 0.0.4，默认启用）

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `HUAGENT_METRICS_ENABLED` | `true` | 置 `false` 时端点返回 404 |
| `HUAGENT_METRICS_TOKEN` | 空 | 非空时要求 `Authorization: Bearer <token>`；**生产必须设置** |

端点已从 HTTP 指标中排除自身采集行为；`path` 标签使用**完整路由模板**（如 `/api/v1/teams/{team_id}/skills`：含 `/api/v1` 前缀，路径参数值归一为 `{name}`；未匹配路由记为 `unmatched`），避免基数爆炸。
数据库不可用时降级返回进程内指标，并累加 `huagent_metrics_collect_errors_total`。

### 指标清单

| 指标 | 类型 | 标签 | 含义 |
| --- | --- | --- | --- |
| `huagent_build_info` | gauge | `version`, `schema_version` | 构建与已应用 DDL 版本（恒为 1） |
| `huagent_http_requests_total` | counter | `method`, `path`, `status` | HTTP 请求数 |
| `huagent_http_request_duration_seconds` | histogram | `method`, `path` | 请求耗时（默认桶 5ms…10s） |
| `huagent_usage_events_total` | counter | `result`=`accepted\|duplicated\|rejected` | 用量事件处理结果 |
| `huagent_login_attempts_total` | counter | `result`=`success\|failure\|disabled\|locked_ip\|locked_account` | 登录结果 |
| `huagent_db_gauge` | gauge | `metric`=`users_total\|approvals_pending\|snapshots_uploading\|skills_published\|activations_total` | 采集时从库读取的状态量 |
| `huagent_job_last_status` | gauge | `job_id`, `status` | worker 任务最近状态（=1 生效） |
| `huagent_job_last_timestamp_seconds` | gauge | `job_id`, `phase`=`started\|finished` | 最近开始/结束时间戳 |
| `huagent_metrics_collect_errors_total` | counter | — | 数据库指标采集失败次数 |
| `huagent_job_staleness_budget_seconds` | gauge | `job_id` | worker 任务「多久未成功完成即异常」的预算秒数（由任务周期推导，见 `worker/schedule.py`） |

> 想直接起一套完整监控（含看板与邮件告警）：见本文档第 7 节「一键部署监控栈」。

## 2. 采集配置

```yaml
# prometheus.yml
scrape_configs:
  - job_name: hu-agent-api
    metrics_path: /api/v1/system/metrics
    authorization:
      credentials_file: /etc/prometheus/huagent_metrics_token
    static_configs:
      - targets: ["hu-agent-api.internal:8080"]
    scrape_interval: 30s
```

## 3. 告警规则

```yaml
# huagent-rules.yml
groups:
  - name: hu-agent
    interval: 30s
    rules:
      # ---- 可用性 ----
      - alert: HuAgentApiDown
        expr: up{job="hu-agent-api"} == 0
        for: 2m
        labels: { severity: critical }
        annotations:
          summary: "API 实例不可达（{{ $labels.instance }}）"
          runbook: "docs/delivery/operations.md#1-健康检查与监控"

      - alert: HuAgentMetricsCollectFailing
        expr: increase(huagent_metrics_collect_errors_total[10m]) > 0
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "指标采集无法访问数据库：数据库可能不可用"
          runbook: "docs/delivery/deployment.md#6-备份与恢复"

      # ---- 错误率与延迟 ----
      - alert: HuAgentServerErrorRate
        expr: |
          sum(rate(huagent_http_requests_total{status=~"5.."}[5m]))
            / clamp_min(sum(rate(huagent_http_requests_total[5m])), 0.001) > 0.05
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "5xx 比例超过 5%"

      - alert: HuAgentP95LatencyHigh
        expr: |
          histogram_quantile(0.95,
            sum(rate(huagent_http_request_duration_seconds_bucket[5m])) by (le, path)
          ) > 1
        for: 10m
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.path }} P95 延迟超过 1s"

      # ---- 认证 ----
      - alert: HuAgentLoginFailuresBurst
        expr: sum(rate(huagent_login_attempts_total{result="failure"}[5m])) > 1
        for: 5m
        labels: { severity: warning }
        annotations:
          summary: "登录失败速率偏高（可能口令爆破），检查 audit_logs 中 auth.login 失败 IP 分布"

      - alert: HuAgentAccountLockouts
        expr: increase(huagent_login_attempts_total{result=~"locked_.*"}[15m]) > 5
        for: 0m
        labels: { severity: warning }
        annotations:
          summary: "多个账号/来源触发登录限流"

      # ---- 业务数据 ----
      - alert: HuAgentUsageEventRejections
        expr: sum(rate(huagent_usage_events_total{result="rejected"}[15m])) > 0.1
        for: 15m
        labels: { severity: warning }
        annotations:
          summary: "客户端用量事件被拒绝，检查时钟偏移/归属校验（sanitized）"

      - alert: HuAgentSnapshotUploadingStuck
        expr: huagent_db_gauge{metric="snapshots_uploading"} > 5
        for: 30m
        labels: { severity: warning }
        annotations:
          summary: "存在长时间未完成的快照上传；worker snapshot.cleanup 超过 24h 会置 aborted"

      - alert: HuAgentApprovalsBacklog
        expr: huagent_db_gauge{metric="approvals_pending"} > 20
        for: 24h
        labels: { severity: info }
        annotations:
          summary: "待审批积压超过 20（审批停滞会影响组织/资源上下架）"

      # ---- worker ----
      - alert: HuAgentWorkerJobFailed
        expr: huagent_job_last_status{status="failed"} == 1
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "worker 任务 {{ $labels.job_id }} 最近一次失败"

      # 预算由任务周期推导并作为指标导出：
      #   心跳/每小时类任务 = 3 倍周期（下限 15 分钟）；每日 cron 任务 = 26 小时
      # 为什么不写死阈值：快照清理/分区维护/PII 清理每日只跑一次，固定 2 小时阈值会持续误报
      - alert: HuAgentWorkerJobStale
        expr: |
          (time() - huagent_job_last_timestamp_seconds{phase="finished"})
            > on(job_id) huagent_job_staleness_budget_seconds
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "worker 任务 {{ $labels.job_id }} 超过预算（{{ $value | humanizeDuration }}）未成功完成"

  - name: hu-agent-recording
    rules:
      - record: huagent:http_error_ratio5m
        expr: |
          sum(rate(huagent_http_requests_total{status=~"5.."}[5m]))
            / clamp_min(sum(rate(huagent_http_requests_total[5m])), 0.001)
      - record: huagent:usage_accepted_rate5m
        expr: sum(rate(huagent_usage_events_total{result="accepted"}[5m]))
```

阈值均为**起步值**，请在 staging 观察一周后按实际基线调整（尤其 P95 与错误率）。

规则的**权威版本**是仓库内的 `docker/observability/prometheus/rules/huagent.yml`（一键部署时直接加载），
本节内容与之保持一致；修改任一处需同步另一处（校验：`promtool check rules`）。

## 4. 看板（Grafana）

| 面板 | 查询 |
| --- | --- |
| 请求速率（按状态） | `sum by (status) (rate(huagent_http_requests_total[5m]))` |
| 5xx 比例 | `huagent:http_error_ratio5m` |
| P50/P95/P99 延迟 | `histogram_quantile(0.95, sum(rate(huagent_http_request_duration_seconds_bucket[5m])) by (le, path))` |
| 登录结果分布 | `sum by (result) (rate(huagent_login_attempts_total[5m]))` |
| 用量事件结果 | `sum by (result) (rate(huagent_usage_events_total[5m]))` |
| 待审批 / 用户在册 / 上传中快照 | `huagent_db_gauge` |
| worker 任务新鲜度 | `time() - huagent_job_last_timestamp_seconds{phase="finished"}` |
| 构建版本 | `huagent_build_info` |

## 5. 与日志、审计的分工

| 层次 | 用途 | 位置 |
| --- | --- | --- |
| 指标 | 趋势与告警（"是否异常"） | 本文档端点 |
| 日志 | 单次请求排障（"为什么"） | API/worker stdout，`X-Trace-Id` 关联 |
| 审计 | 谁做了什么（合规） | `audit_logs` 表 + 客户端 `.hu/logs/audit.jsonl` |
| 诊断包 | 客户端现场 | 「关于」→ 导出（见 `operations.md` 第 2 节） |

## 6. 尚未覆盖（诚实清单）

- **客户端侧指标**（如崩溃率、工具调用失败率、MCP 连接失败率）：目前只有本地日志与用量上报，
  没有远端聚合；建议 v1.x 在用量事件中增加 `client_feature_*` 维度或接入崩溃上报（需先做隐私评审）。
- **对象存储与 Redis 指标**：直接采集 MinIO/Redis 自带导出器，与本端点无关。
- **告警通知渠道**：Alertmanager 与收件人配置已内置（第 7 节，默认邮件；企业 IM 需自建 webhook 网关）。
- **从未成功完成过的任务**：`HuAgentWorkerJobStale` 依赖 `huagent_job_last_timestamp_seconds{phase="finished"}`，
  若某任务自部署起从未成功完成（无任何时间戳），该规则不会触发；上线首日请人工确认 8 个任务都至少成功过一次
  （Grafana「后台任务与业务数据」看板的「最近状态」表格）。

## 7. 一键部署监控栈（中小企业自托管）

目标：一条命令得到「指标采集 + 预置看板 + 邮件告警」，不要求运维熟悉 Prometheus。
编排文件 `docker/compose.observability.yaml` 是**叠加层**，可叠在快速开始编排上，也可独立运行。

```bash
# 推荐：与快速开始一起（自动生成指标令牌、抓取目标、告警收件人）
scripts/quickstart.sh up --email you@example.com --with-monitoring
# 已经部署好了业务服务，只想加监控：
scripts/quickstart.sh monitoring up                  # 指标 + 看板 + 告警（含内置收件箱 Mailpit）
scripts/quickstart.sh monitoring up --with-logs      # 再叠加 Loki 容器日志聚合（仅 Linux 宿主机）
scripts/quickstart.sh monitoring status              # 检查各组件与抓取健康
scripts/quickstart.sh monitoring down                # 只停监控，业务服务与数据卷不受影响
```

服务端跑在宿主机（开发环境）时，让 Prometheus 抓宿主机端口：

```bash
scripts/quickstart.sh monitoring up --target host.docker.internal:8080
```

### 7.1 组件与端口（默认只绑 127.0.0.1）

| 组件 | 端口 | 用途 | 备注 |
| --- | --- | --- | --- |
| Grafana | 3000 | 4 个预置看板（见 7.2） | 账号 `admin`，口令在 `.env.quickstart` 的 `GRAFANA_ADMIN_PASSWORD` |
| Prometheus | 9090 | 指标库与规则求值 | 保留期 `PROM_RETENTION`（默认 15d） |
| Alertmanager | 9093 | 告警分组与投递 | 路由与收件人见 `docker/observability/alertmanager/alertmanager.yml` |
| Mailpit | 8025 | 默认告警收件箱（本地邮件墙） | 接企业邮箱后可以不启动 |
| Loki | 3100 | 日志存储（`--with-logs`） | 保留 30 天（`LOKI_RETENTION`） |

生成物（已 gitignore，含密钥，勿提交）：`docker/observability/prometheus/huagent_metrics_token`、
`docker/observability/prometheus/targets/huagent-api.yml`、`docker/observability/alertmanager/alertmanager.yml`。

### 7.2 预置看板

| 看板 | 内容 |
| --- | --- |
| API 黄金指标 | 请求速率、5xx 比例、P50/P95/P99、最慢路由 Top10、采集状态、构建与 schema 版本 |
| 后台任务与业务数据 | 任务新鲜度（对比各自预算）、任务最近状态、DB 状态量、用量事件结果、待审批/上传中快照 |
| 认证与 SSO | 登录结果分布、失败速率、限流触发、认证端点请求量 |
| 日志（Loki） | 错误与异常、API/worker 全量日志（按 `service` 过滤，支持 trace_id） |

### 7.3 接企业邮箱

改 `.env.quickstart` 后重跑 `monitoring up` 即可（会按模板重新渲染收件人）：

```ini
SMTP_SMARTHOST=smtp.example.com:587
SMTP_REQUIRE_TLS=true
ALERT_EMAIL_FROM=huagent@example.com
ALERT_EMAIL_TO=ops@example.com
```

需要认证时，在生成的 `alertmanager.yml` 里补 `smtp_auth_username` / `smtp_auth_password`
（该文件权限 600 且已 gitignore）。企业 IM（钉钉/飞书/企微）走通用 webhook：
`alertmanager.yml` 里取消 `webhook` 接收器注释，并在 `route` 中为其加一条路由。

### 7.4 验证与自检

```bash
scripts/quickstart.sh monitoring status     # 组件 + hu-agent-api 抓取健康
# 观察任务实际用时占预算的比例（>100% 即会告警）
curl -s --get --data-urlencode 'query=(time() - huagent_job_last_timestamp_seconds{phase="finished"}) / on(job_id) huagent_job_staleness_budget_seconds' http://localhost:9090/api/v1/query
# 演练一条告警（不碰业务）：向 Alertmanager 注入合成告警，然后在 8025 收件箱里看邮件
curl -s -X POST http://localhost:9093/api/v2/alerts -H 'content-type: application/json'   -d '[{"labels":{"alertname":"HuAgentVerifySynthetic","severity":"critical"},"annotations":{"summary":"pipeline check"}}]'
```

### 7.5 生产注意事项

1. 本栈默认只监听 `127.0.0.1`：对运维开放 Grafana 时请置于 TLS 反向代理与认证之后（可只读匿名：`GRAFANA_ANONYMOUS=true`）。
2. Prometheus/Grafana 建议部署在独立主机或独立故障域，避免与服务端一起挂掉；多实例服务端在 `targets/huagent-api.yml` 里加多条目标即可。
3. `--with-logs` 依赖宿主机 `/var/lib/docker` 与 `docker.sock`，**仅 Linux 可用**；Docker Desktop（Windows/macOS）请改用宿主日志或 Grafana Alloy。
4. 生产必须设置 `HUAGENT_METRICS_TOKEN`（一键部署会自动生成）：指标端点会带业务规模信息，不要裸奔在公网。
