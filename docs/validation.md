# 自验证清单（v0.1.0）

> 用途：**采用方/维护者的自验证清单**。每个场景给出「前置 / 操作 / 预期」，逐项可复现；
> 用于升级前回归、部署验收与问题定位。环境建议：一台开发/测试机 + Docker，按 `docs/delivery/deployment.md` 或 `scripts/quickstart.sh` 起服务。

## 0. 环境准备（约 5 分钟：推荐一条命令）

```bash
scripts/quickstart.sh up --email you@example.com   # 生成密钥 → 起全栈 → 迁移 → 建首个管理员
```

以下为手工等价步骤（需要自定义部署时使用）：

```bash
# 1) 依赖（PostgreSQL 18 / Redis / MinIO（源码构建）/ Keycloak / Mailpit）
scripts/dev-deps.sh up

# 2) 数据库（幂等，含 V0001–V0005）
HUAGENT_DATABASE_URL=postgresql://huagent:huagent_dev@localhost:5432/huagent \
  uv run --project management huagent-admin db-migrate

# 3) 服务端 + worker
(cd management && uv run huagent-api > /tmp/huagent-api.log 2>&1 &)
(cd management && uv run huagent-worker > /tmp/huagent-worker.log 2>&1 &)
curl -s http://127.0.0.1:8080/api/v1/system/health

# 4) 种子数据（账号 / 组织 / 团队 / 已发布 Skill / 用量事件）
uv run --project management python scripts/ci/seed-e2e.py
uv run --project management python -c "import asyncio; from huagent.common.runtime import new_event_loop; \
  from huagent.worker.jobs import run_job, aggregate_usage; \
  print(asyncio.run(run_job('usage.aggregate', aggregate_usage), loop_factory=new_event_loop))"

# 5) 客户端与管理台
(cd app && npm run dev &)                     # 桌面客户端
(cd management-ui && npm run dev &)           # 管理台 http://localhost:5173
```

演示账号（种子脚本创建，密码均为 `Str0ng-Passphrase-2026`）；自验证时也可直接用 quickstart 创建的管理员账号：

| 账号 | 角色 |
| --- | --- |
| `sysadmin@example.com` | 系统管理员 |
| `owner@example.com` | 组织管理员 + 团队管理员 |
| `member@example.com` | 组织/团队普通成员 |

## 1. 客户端：核心对话与权限（约 10 分钟）

| # | 操作 | 预期 |
| --- | --- | --- |
| 1.1 | 启动客户端 → 出现**登录门禁** | 不登录无法进入任何页面；服务端不可达时只有「重试连接」（D16 / ADR 0004） |
| 1.2 | 用 `member@example.com` 登录 | 进入对话页；底部状态显示账号 |
| 1.3 | 新建会话，输入：`读取 package.json 并总结脚本` | 出现工具卡片与**授权弹窗**（工作空间内读取可直接放行；越界会询问） |
| 1.4 | 在授权弹窗选择「本会话允许」 | 后续同类调用不再询问；`<workspace>/.hu/logs/audit.jsonl` 出现记录（「权限与审计」Tab 可查） |
| 1.5 | 让 Agent 执行 `rm -rf .hu` 之类的危险命令 | 被拒绝（保护文件/危险命令），对话中说明原因 |
| 1.6 | 顶部切到「模型配置」新增供应商 | 保存后可在对话页选择模型；密钥写入系统密钥库（`secrets.enc.json`，界面显示「已配置密钥」） |
| 1.7 | 顶部「Skill 配置」→ 启用一个本地 Skill | 首次启用有权限声明确认；启用后系统提示注入该 Skill |
| 1.8 | 顶部「MCP 配置」→ 添加 filesystem server（`npx -y @modelcontextprotocol/server-filesystem <目录>`）→ 测试连接 | 显示工具数；对话中可用 `mcp__filesystem__*` 工具 |
| 1.9 | 顶部「用量统计」→ 切换范围/日期 → 导出 CSV | 图表与明细正确；CSV 带 UTF-8 BOM（Excel 中文不乱码） |
| 1.10 | 顶部「关于」→ 导出诊断包 | 生成 zip；解压可见日志与配置，**密钥字段为 `***`、主目录为 `~`、无 secrets.enc.json** |
| 1.11 | 个人中心 → 语言切换 English | 界面即时切换为英文（含系统提示回复语言） |

## 2. 客户端：市场、同步、合规（约 10 分钟）

| # | 操作 | 预期 |
| --- | --- | --- |
| 2.1 | 顶部「市场」→ 搜索 `demo-skill` → 安装 → 在 Skill 配置启用 | 安装即校验 sha256 并安全解压到 `~/.hu-agent/skills/<name>/<version>/` |
| 2.2 | 顶部「云同步」→ 立即同步 | 显示版本号；`~/.hu-agent` 与该工作空间产生快照（服务端可见） |
| 2.3 | 换一台机器（或用 `SYNC_E2E` 脚本模拟）修改文件后再分别同步 | 冲突时**不自动覆盖**，出现三选项（保留本地副本后覆盖 / 导出差异清单 / 取消） |
| 2.4 | 选择「保留本地副本后覆盖」 | 本地改动存入 `.hu/sync/conflicts`，工作空间为服务端版本 |
| 2.5 | 「云同步」→ 历史版本 → 恢复 | 恢复前自动备份到 `.hu/backups`；回滚结果作为新版本上传 |
| 2.6 | 个人中心 → 数据与隐私 → 导出我的数据 | 生成 JSON（资料/设备/通知/激活/用量日聚合），界面提示路径 |
| 2.7 | （可选，单独账号）数据与隐私 → 注销账号 | 需输入邮箱确认；提交后回到登录门禁；该账号无法再登录 |

## 3. 管理台：审批与资源治理（约 10 分钟）

| # | 操作 | 预期 |
| --- | --- | --- |
| 3.1 | 打开 http://localhost:5173 → 用 `owner@example.com` 登录 | 进入概览；左侧仅显示有权限的菜单（无「身份源」） |
| 3.2 | 用 `member@example.com` 通过 `.http`/脚本提交一个团队申请或新 Skill 版本 | 管理台「审批」出现待处理记录（顶部铃铛有未读提示） |
| 3.3 | 管理台「审批」→ 范围「本组织」→ 打开详情 → 填写意见 → 通过 | 记录变为「已通过」；申请人客户端收到通知（英文账号收到英文通知） |
| 3.4 | 「Skill 管理」→ 选择团队 → 打开详情 | 显示 SKILL.md、版本列表、状态版本号 |
| 3.5 | 对已上架 Skill 执行「停用」并填写原因 | 客户端资源状态检查立即硬停用并显示原因；已启用用户收到通知 |
| 3.6 | 停用后「启用」，再对某版本「撤回版本」 | 撤回后服务端指向替代版本（若有），客户端按状态检查处理 |
| 3.7 | 「成员与邀请」→ 邀请成员（填写邮箱） | 展示一次性邀请码；成员在客户端输入后加入 |
| 3.8 | 用 `sysadmin@example.com` 登录 → 「身份源（SSO）」 | 可见已配置的 Keycloak；编辑时 Client Secret 留空表示不改（只写不读） |
| 3.9 | 顶部语言切 English | 管理台界面即时英文；偏好写入 `users.locale`（重新登录仍生效） |

## 4. 服务端：安全与合规（约 10 分钟）

| # | 操作 | 预期 |
| --- | --- | --- |
| 4.1 | `curl -s http://127.0.0.1:8080/api/v1/system/metrics \| head` | Prometheus 文本指标（HTTP/用量/登录/库状态/worker 新鲜度） |
| 4.2 | 连续输错密码 5 次 | 账号临时锁定；再次登录提示剩余时间（Redis 限流生效） |
| 4.3 | `uv run --project management python scripts/sso-live-check.py --issuer http://127.0.0.1:8081/realms/huagent ...` | 真实 Keycloak 全链路（RS256+JWKS、JIT 建号、禁用即时撤销会话）通过 |
| 4.4 | 查看 `audit_logs`（`psql` 或管理台阶段 B 页面） | 登录、审批、资源上下架、停用/撤回、注销申请均有记录，含 actor/ip/时间 |
| 4.5 | 注销账号后 30 天（演示可用 SQL 把 `deletion_requested_at` 提前）→ 触发 worker `user.purge` | 邮箱/昵称/设备/通知被清理，用量统计仍连续（匿名占位） |
| 4.6 | `bash scripts/security-scan.sh` | 依赖与静态扫描全绿（无高危） |

## 5. 端到端自动回归（约 5 分钟，可与人工验证并行）

```bash
bash scripts/check-all.sh                                   # 服务端 + 客户端 + 管理台
HUAGENT_TESTCONTAINERS=1 uv run --project management pytest -m integration -q   # 25 项集成（真实 PG）
cd app && CLOUD_E2E=1 MARKET_E2E=1 SYNC_E2E=1 STATS_E2E=1 npx vitest run tests/integration   # 4 条真实链路
```

CI（`.github/workflows/ci.yml`）在每次推送时执行上述内容 + 真实 S3（源码构建 MinIO）+ 真实 IdP（Keycloak）冒烟。

## 6. 自验证确认表

| 项 | 检查内容 | 结论（通过/不通过/备注） |
| --- | --- | --- |
| 强制登录 | 无本地绕过路径；服务端不可用时不可进入（ADR 0004） | |
| 权限与审计 | 越界授权、保护文件拒绝、审计可查 | |
| 工具与扩展 | 内置工具、Skill、MCP 均可按预期工作 | |
| 市场治理 | 安装/启停/上下架/撤回/删除全链路生效 | |
| 云同步 | 手动+定时同步、冲突不自动覆盖、可恢复 | |
| 统计 | 用量对账（客户端上报 vs 服务端聚合）、CSV 导出 | |
| 管理台 | 审批、Skill 治理、成员与邀请、身份源可用 | |
| 合规 | 数据导出、注销与 30 天清理、审计保留、日志脱敏 | |
| 国际化 | 客户端/管理台/通知中英双语，语言偏好持久化 | |
| 可观测 | 健康检查、指标、告警规则、诊断包 | |

验证人：________ 日期：________ 复核人：________ 结论：________

## 7. 验证前须已知的边界（避免误判）

1. **必须登录**：企业身份管控要求，服务端不可用时应用不可进入（发布说明已注明）。
2. **管理台已覆盖阶段 A + B**（审批、Skill 治理、成员与邀请、身份源、统计、组织治理、通知、审计、设置）；
   尚未提供「系统区用户管理页面」，该场景请用 `huagent-admin` CLI（`list-users` / `disable-user` / `reset-password`）。
3. **安装包未签名**：Windows SmartScreen 会提示未知发布者；请核对 Release 附带的 SHA256SUMS，企业分发按 `docs/delivery/signing.md` 自行重签。
4. **性能结论为单机基线**（`docs/delivery/performance.md`），生产容量需在 staging 按目标拓扑复测。
5. **监控需自行接入**：指标端点与 12 条告警规则已就绪（`docs/delivery/monitoring.md`），Prometheus/Grafana 与值班按自身环境配置。
