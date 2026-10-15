# 变更日志

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/) 与
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的组织方式。

## [Unreleased]

### 新增

- 可观测性一键部署（`docker/compose.yaml` 的 `monitoring` profile + `scripts/quickstart.sh` 系列入口）：
  Prometheus（12 条告警规则与 3 条记录规则开始随仓库分发）、Grafana（4 个预置看板：
  API 黄金指标 / 后台任务与业务数据 / 认证与 SSO / 日志）、Alertmanager（邮件路由，默认投递到内置
  Mailpit 收件箱；企业 SMTP 与 webhook 见文档）、可选 Loki + Promtail 日志聚合（profile: logs）。
- 新指标 `huagent_job_staleness_budget_seconds{job_id}`：worker 任务「多久未成功完成即异常」的预算，
  由任务周期推导（心跳/每小时任务 = 3 倍周期且不低于 15 分钟；每日 cron 任务 = 26 小时）。
- 定时任务表收敛到 `worker/schedule.py`（唯一的调度与预算来源），worker 启动改用它注册。

### 修复

- `HuAgentWorkerJobStale` 告警阈值写死 2 小时，导致每日 cron 任务（分区维护、快照清理、PII 清理、
  日聚合清理）在两次执行之间必然持续误报；改为与各任务预算比较。
- `prometheus.yml` 缺少 `alerting.alertmanagers` 配置：规则会 fire 但不会发出任何通知（实测发现）。
- worker 任务周期与调度器不一致（原 `__main__.py` 与文档各处手写）导致的维护风险。

## [0.1.0] - 2026-10-14

首个公开版本：客户端（桌面）+ 服务端 + 管理台三件套一并开源，Apache-2.0。

### 新增

**客户端（`app/`）**
- Agent 核心循环：多协议模型网关（`openai-chat` / `openai-responses` / `anthropic-messages`）、
  思考强度、失败重试、会话取消、上下文压缩（70% 阈值）
- 工具与沙箱：读/写/编辑/Shell/搜索/引导工位；工作空间内直许、越界询问、敏感路径拒绝；
  Shell 进程树终止；授权卡片（一次/本会话/始终）写入工作空间策略；审计落盘 `.hu/logs/audit.jsonl`
- 扩展：Skill（front matter 解析、版本目录、系统提示渐进披露）、MCP（stdio，JSON-RPC，
  惰性连接 + 空闲回收 + 崩溃重连，密钥入系统密钥库）
- 市场：浏览/安装（sha256 校验 + 安全解压）/启用/卸载；服务端状态检查（硬停用与恢复）
- 云同步：整包快照、手动与定时（15m/30m/1h/6h/24h）、冲突三选项、恢复前备份、历史版本
- 用量统计与 CSV 导出；文件日志（10MB × 5 滚动）与诊断包导出（脱敏、不含密钥库）
- 强制登录门禁（无本地绕过路径）；中英双语（`zh-CN` / `en-US`）

**服务端（`management/`）**
- 账号与安全：argon2id、JWT（access 15 分钟）+ 旋转 refresh（家族重放检测）、设备吊销、
  登录限流（IP + 账号递增锁定）、弱口令名单
- 组织/团队/RBAC（不可见即 404）、邀请（一次性 7 天）、审批流（组织/团队创建、Skill 版本发布）
- 市场：上传校验（zip 逃逸/炸弹/反斜杠走私/符号链接）、版本审批发布、上下架、停用（必填原因）、
  撤回（替代版本）、删除、pg_trgm 搜索、预签名下载
- 云同步：快照 init/complete（流式 sha256）、配额交叠、保留与钉住、清理任务
- 统计：小时聚合到日表（价格快照）、按日/模型/成员/团队/组织、激活明细
- SSO：OIDC + PKCE（HS256/RS256/ES256 + JWKS）、JIT 建号与邮箱域白名单、禁用即时撤销会话
- 数据生命周期：本人数据导出、注销（30 天宽限期后清理 PII，用量匿名保留）、保留策略
- 可观测：Prometheus 指标端点、结构化日志与 `X-Trace-Id`、worker 任务记录与启动补偿
- 审计：登录/审批/资源治理/账号操作全量留痕

**管理台（`management-ui/`）**
- 登录（本地账号 + SSO PKCE）、审批、Skill 审核与生命周期、成员与邀请、身份源（SSO）管理
- 统计图表与 CSV、组织与团队治理（冻结/解散）、通知中心、审计日志、系统设置与模型价格表
- 中英双语；类型由 OpenAPI 生成（`npm run api:gen`），`npm run check` 强制同源

**工程与交付**
- monorepo、编号 DDL（V0001–V0005，含回滚）、CI 五作业（含真实 S3 + 真实 IdP 端到端）、
  依赖与静态扫描、性能基准脚本、签名打包脚本与文档、adopters 自验证清单

### 已知限制

见 [`docs/delivery/release-notes.md`](docs/delivery/release-notes.md) 第 5 节（管理台用户管理页面、
安装包签名、监控接入、staging 性能复测、邮件通道、MCP http/sse 与 MCP 市场、macOS 实机验证）。
