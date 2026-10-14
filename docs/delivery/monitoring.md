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

      - alert: HuAgentWorkerJobStale
        expr: |
          time() - huagent_job_last_timestamp_seconds{phase="finished"} > 7200
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "worker 任务 {{ $labels.job_id }} 超过 2 小时未成功完成（含启动补偿机制失效）"

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
- **告警通知渠道**（邮件/IM/值班）：属于企业侧配置，Alertmanager 接收器不在本仓库内。
