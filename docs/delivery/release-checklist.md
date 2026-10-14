# 发布前清单执行状态（附录 E）

> 对应 `docs/plan.md` 附录 E。图例：✅ 完成并留证 / ⏳ 部分完成 / ❌ 未完成（阻塞发布，需补齐或需求方确认延后）。
> 每项给出证据位置；未完成项附建议动作。

## 功能与体验

| 项 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| 管理台可完成全部管理操作 | ✅ | 阶段 A（登录、审批、Skill 审核与生命周期、成员与邀请、身份源、个人设置）+ 阶段 B（统计图表与 CSV、组织/团队治理与冻结/解散、通知中心、审计日志、系统设置与价格表、**管理台 SSO 登录**）；Playwright 实机走查 0 控制台错误，SSO 经真实 Keycloak 全链路验证。**遗留**：系统区用户管理页面（列表/禁用/重置） |
| 英文 i18n（D13） | ✅ | 客户端：496 键中英齐平、渲染层与主进程零漏翻（`i18n.test.ts` 13 项 + AST 扫描工具）、语言切换即时生效并同步 `users.locale`；**服务端站内通知按收件人 `users.locale` 渲染**（`domain/messages.py` + 19 项单测 + 集成断言「中文用户中文、英文用户英文」）；管理台现有页面双语 + 顶部切换。**约束：5-09 新增页面必须同步双语** |
| 统计图表与 CSV 导出 | ✅ | 客户端「用量统计」Tab（按日柱状图、维度明细、激活明细、CSV UTF-8 BOM）；`app/tests/stats-csv.test.ts`、`STATS_E2E` 实测 |
| 定时同步 + 冲突处理 | ✅ | 档位 关闭/15m/30m/1h/6h/24h；单飞/冲突暂停/失败重试；`app/tests/sync-scheduler.test.ts`、`tests/market-status.test.ts` |
| SSO 真实 IdP 验证 | ✅ | Keycloak 26.3 实测（RS256+JWKS、JIT、绑定、禁用撤销）：`scripts/sso-live-check.py`；CI `e2e` 作业每次回归 |

## 安全与合规

| 项 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| 安全用例全结（路径逃逸/zip/越权/令牌重放） | ✅（有小结，扫描待补） | `docs/delivery/security-review.md` 第 1-5 节逐条列证据（单测 + 集成 + 真实联调） |
| 依赖与静态扫描无高危未处理 | ✅ | `scripts/security-scan.sh` + CI `security` 作业（pip-audit / bandit medium+ / npm audit --omit=dev 全绿）；开发依赖豁免与后续动作见 `security-review.md` 第 6 节 |
| 审计/保留/删除策略按 6.10.5 自检 | ✅ | 导出（`GET /me/export`）、注销（`POST /me:delete`：立即停用+撤销会话）、宽限期后 PII 清理（worker `user.purge`，用量改挂匿名占位保证统计连续）、日聚合保留 730 天（`usage.daily.prune`）、客户端「数据与隐私」入口；证据：`management/tests/integration/test_lifecycle.py` 2 项集成测试 + design 6.10.5 实现说明 + `operations.md` 4.1 |
| 保护文件、权限矩阵与产品说明一致 | ✅ | `app/src/main/permissions/*` + `tests/permissions-*`；design 5.5 与「权限与审计」Tab 展示一致 |

## 交付物

| 项 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| Windows/macOS 签名安装包 + 升级回滚验证 | ⏳ | 脚本与文档就绪：`scripts/package.ps1`、`scripts/package.sh`、`docs/delivery/signing.md`（含校验与回滚章节）；**缺企业证书与实测记录** |
| 部署 / 使用 / 运维手册 | ✅ | `docs/delivery/deployment.md`、`user-guide.md`、`operations.md`、`monitoring.md`、`performance.md` |
| staging/prod 监控与告警 | ⏳ | 已实现 `/api/v1/system/metrics`（Prometheus 文本 + 可选令牌）与 `docs/delivery/monitoring.md`（采集配置、12 条告警规则、看板查询、未覆盖清单）；**待企业侧**：接入 Prometheus/Grafana、配置 Alertmanager 接收器与值班表 |
| 发布冒烟 E2E 5 条 + 性能结论 | ⏳ | CI `e2e` 作业覆盖登录与上报对账、市场安装、云同步（两机）、统计聚合、SSO 真实 IdP；性能基线已出（`docs/delivery/performance.md`：4 场景 × 3 并发档、0 失败）。**staging 目标拓扑复测未做**（见该文档第 5 节清单） |

## 用户与需求方

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 需求方验收演示 | ⏳ | 材料就绪：`docs/delivery/acceptance.md`（前置环境 + 4 组场景 + 自动回归 + 验收确认表，含「演示前须已知事项」避免误解）；**待需求方确认时间与参会人** |
| 遗留问题清单经需求方确认 | ⏳ | 清单已整理并体现在 `docs/delivery/release-notes.md` 第 5 节（管理台阶段 B、签名证书、监控接入、staging 性能、邮件通道、MCP http/sse 与市场、macOS 实机验证）；**待需求方确认接受或调整优先级** |

## 本次（阶段 7）新增产物

- i18n：`app/src/shared/i18n/`（词典 + 业务码）、`app/src/renderer/src/i18n.ts`、`app/src/main/i18n.ts`、
  `app/scripts/i18n-*.mjs`（AST 扫描/迁移/报告/一致性检查）
- 客户端：文件日志（10MB × 5 滚动）+ 诊断包导出（脱敏、不含密钥库）与「关于」页入口
- CI：`security` 作业（依赖与静态扫描）、`e2e` 作业（源码构建 MinIO + PG/Redis + 真实 API + Keycloak），失败自动收集日志
- 打包：`scripts/package.sh`、`scripts/package.ps1`、electron-builder 签名配置、macOS 公证开关与 entitlements
- 文档：`docs/delivery/{signing,deployment,operations,user-guide,security-review}.md` 与本清单
