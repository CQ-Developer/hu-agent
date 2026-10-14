# 安全评审小结（v1 交付用）

> 用途：附录 E「安全用例全结并留有报告」的支撑材料。每条列出威胁、实现位置与验证证据。
> 结论：**已实现并自动化验证的项**逐条列证据；**未完成项**在最后一节明确标注。

## 1. 路径与文件系统

| 威胁 | 实现 | 证据 |
| --- | --- | --- |
| 路径逃逸（`..`、软链接、UNC、Windows 保留名、`\\?\` 设备路径、8.3 短名） | `app/src/main/permissions/paths.ts`（realpath 归一化 + 前缀断言） | `tests/permissions-paths.test.ts`（含 Windows 用例） |
| 敏感路径读取（`~/.ssh`、`~/.aws`、Keychain） | 硬规则直接 `deny`，不弹授权卡 | `tests/permissions-engine.test.ts` |
| 保护文件写入（`.hu/settings.json`、`mcp.json`、`logs/**`、`~/.hu-agent/*.json` 等 11 类） | `isProtectedWritePath` 硬拒绝 | 同上 |
| 命令执行失控 | 进程树终止（`taskkill /T`、POSIX 进程组）、1MB 流限量、超时/取消 | `tests/shell-tool.test.ts` |

## 2. 包与解压（Skill 市场）

| 威胁 | 实现 | 证据 |
| --- | --- | --- |
| zip-slip / 绝对路径 / 反斜杠 / 盘符 | 客户端 `market/zip.ts` + 服务端 `domain/packages.py` 双重拒绝 | `tests/market-zip.test.ts`、`management/tests/test_packages.py` |
| 符号链接条目 | 双方检查 `external_attr` 类型位 | 同上 |
| zip 炸弹（压缩比/解压总量/单文件/文件数） | 读取时逐项限制（客户端 500 文件/100MB/200:1；服务端同） | 同上 |
| 加密条目 / Zip64 / 数据损坏 | 读取时拒绝，CRC 校验 | `tests/market-zip.test.ts` |
| **反斜杠走私**（PowerShell `Compress-Archive` 产出 `scripts\run.sh`，Python `zipfile` 的 `filename` 会归一化而 `orig_filename` 保留原样） | 服务端按 `orig_filename` 校验 | `management/tests/test_packages.py::test_reject_backslash_entries_smuggled_via_zipfile_normalization` |
| 内容与摘要不符 | 下载后 sha256 校验（客户端）+ 服务端 `complete` 流式 sha256 | `tests/market-installer.test.ts`、`test_stage6_flow.py` |

## 3. 认证与会话

| 威胁 | 实现 | 证据 |
| --- | --- | --- |
| 口令爆破 / 账号枚举 | argon2id；失败不区分用户存在；IP 10/min + 账号 5 次递增锁 | `management/tests/test_ratelimit.py`、`test_auth_flow.py` 集成 |
| refresh 令牌重放 | 旋转 + 家族撤销 + 站内通知 | `test_auth_flow.py::test_refresh_rotation_and_replay_detection` |
| 设备吊销 | 撤销该设备全部 refresh token，客户端立即退回门禁 | `test_auth_flow.py::test_revoke_device_invalidates_refresh` |
| SSO 回跳劫持 / code 重放 | state + nonce + 三方 PKCE；一次性 code 60s 单次；回跳地址仅回环或 `cors_origins` | `management/tests/integration/test_stage7_sso.py`、`app/tests/sso-flow.test.ts` |
| IdP 密钥泄露 | `client_secret` AES-GCM 加密存储、只写不回显；禁用身份源即时撤销会话 | 同上 + `scripts/sso-live-check.py` 实测 |
| 令牌明文落盘 | 仅 access 在内存；refresh 存系统密钥库加密文件 | `tests/cloud-client.test.ts` |

## 4. 越权与范围隔离

| 威胁 | 实现 | 证据 |
| --- | --- | --- |
| 横向越权（读他人组织/团队/资源） | 不可见一律 404；SQL 层范围过滤 | `test_stage5_flow.py::test_org_team_rbac_and_audit`、`test_usage_api.py` |
| 纵向越权（普通成员执行管理员操作） | `require_*_access(admin=True)` → 403 | 同上 |
| 团队资源越权（组织管理员审阅） | 允许但强制写 `rbac.override.*` 审计 | `test_stage5_flow.py` |
| 用量归属伪造 | team/workspace 归属校验，不可信归属置空并计数（`sanitized`） | `test_usage_api.py::test_batch_accept_duplicate_and_isolation` |
| 统计越权 | self/team/org/global 逐级断言 | `test_stage6_flow.py::test_usage_aggregation_pricing_and_stats` |

## 5. 审计与隐私

| 项 | 实现 | 证据 |
| --- | --- | --- |
| 关键操作审计 | 登录/刷新/设备/审批/资源上下架/停用撤回/同步快照/SSO/越权 | 各集成测试 + `audit_logs` 查询 |
| 上报隐私边界 | 仅模型/token/耗时/状态/会话哈希（盐值本地随机）；不含提示词、回复、路径、工具参数 | `tests/cloud-reporter.test.ts`、`docs/design.md` 5.10.2 |
| 诊断包脱敏 | 不含密钥库；敏感字段 `***`；主目录 `~` | `tests/logging-diagnostics.test.ts` |
| 服务端不存模型/MCP 密钥 | 密钥只在客户端；服务端只存 IdP `client_secret`（加密） | design 6.10.2 |

## 6. 自动化扫描（CI 强制）

`scripts/security-scan.sh`（CI `security` 作业）每次提交都执行，三项均须全绿：

| 扫描 | 范围 | 当前结果 |
| --- | --- | --- |
| `pip-audit`（2.10.1） | `management` 全量依赖（`uv export` 导出，排除自身包） | **No known vulnerabilities found** |
| `bandit`（1.9.4，仅 medium 及以上） | `management/src`（6628 行） | **0 项**（6 处已评审项用行内 `# nosec` 标注并附原因） |
| `npm audit --omit=dev` | `app`（产物只含运行时依赖）、`management-ui` | **0 vulnerabilities** |

**已评审并标注的 6 处（均非用户输入）**：

| 位置 | 规则 | 原因 |
| --- | --- | --- |
| `api/routes/approvals.py` 审批列表计数 | B608 | `where` 由静态条件片段拼接，值全部为绑定参数 |
| `api/routes/stats.py` 用量统计 / 总计 | B608 | 改为 `_USAGE_SQL_TEMPLATE.format(...)`，占位符仅来自白名单 `GROUP_BY_DIMS` 与静态条件 |
| `api/routes/stats.py` 激活明细 | B608 | 同上，`_ACTIVATIONS_SQL` 模板 + 白名单片段 |
| `domain/oidc.py` discovery / token 请求 | B310 | 仅访问管理员配置的身份源端点；`url` 不由终端用户输入控制 |

### 豁免（含开发依赖，不阻断构建）

`app` 完整 `npm audit` 报告 21 项（5 moderate / 13 high / 3 critical），全部位于**开发依赖**：

| 包 | 严重度 | 说明 |
| --- | --- | --- |
| `tinypool`（经 `vitest@3.2.7` 引入） | 3 critical | 原型污染 gadget→RCE，触发前提是攻击者已能控制测试运行参数；修复需 `vitest@5`（大版本） |
| 其余 `vitest`/`esbuild`/`node-gyp` 链路 | 中高 | 同上，均不进入安装包 |

依据：`electron-builder.yml` 只打包 `out/**` 与 `package.json`，`devDependencies` **不会进入分发产物**；因此以
`npm audit --omit=dev` 为发布门禁。

**后续动作**：待 `vitest@5` 稳定后升级，届时完整 `npm audit` 也需清零（已记入发布清单遗留项）。

## 7. 未完成 / 待办（不隐瞒）

| 项 | 状态 | 建议 |
| --- | --- | --- |
| 依赖与静态扫描（npm audit / pip-audit / bandit）接入 CI 并清零高危 | ✅ 已接入 | `scripts/security-scan.sh` + CI `security` 作业；生产依赖与源码扫描 0 项（见第 6 节） |
| 管理台（5-09）与英文 i18n（D13） | ❌ 未做 | 发布前按附录 E 补齐或经需求方书面确认延后 |
| 签名安装包实测、升级/回滚演练 | ⏳ 脚本与文档就绪，缺证书 | 用企业证书执行 `scripts/package.ps1` / `package.sh --mac` 并保存记录 |
| staging/prod 监控告警与值班 | ❌ 未落地 | 按 `docs/delivery/operations.md` 第 1 节接入（health/ready + worker job_runs） |
| 性能验证（并发登录/上报/快照） | ❌ 未做 | 建议以 k6 或 locust 跑 `usage:batch` 与 `snapshots:init/complete`，记录 P95 与容量拐点 |
| 6.10.5「审计/保留/删除」逐条自检 | ⏳ 部分 | 保留与审计已实现；用户数据删除接口（GDPR 类）未实现，需需求方确认范围 |
