# 贡献指南

> English: [CONTRIBUTING.md](CONTRIBUTING.md)

感谢你有意参与 hu-agent。本项目以 [Apache-2.0](LICENSE) 发布，默认接受你的贡献在同等许可下分发。

## 先读这个

- [`docs/design.md`](docs/design.md)：设计基线（架构、接口、数据模型、安全机制）。
- [`docs/plan.md`](docs/plan.md)：执行计划与完成标准；**附录 F 是硬性纪律**：
  任何设计与决策变动必须在同一次提交内同步更新 `docs/`（design/plan/openapi/ddl/ADR），代码与文档不一致视为未完成。
- [`docs/adr/`](docs/adr/)：关键决策记录。改变既有决策请新增 ADR，而不是直接改结论。
- [`docs/validation.md`](docs/validation.md)：自验证清单（提交 PR 前建议本地跑一遍）。

## 开发环境

前置：Python 3.14、[uv](https://docs.astral.sh/uv/)、Node ≥ 20、Docker（集成测试与依赖服务用）。

```bash
# 依赖服务（PostgreSQL 18 / Redis / MinIO（源码构建）/ Keycloak / Mailpit）
scripts/dev-deps.sh up

# 服务端：应用 DDL → 起 API 与 worker
cd management && uv sync --frozen
uv run huagent-admin db-migrate
uv run huagent-admin create-admin --email you@example.com    # 首个系统管理员（口令只打印一次）
uv run huagent-api        # http://127.0.0.1:8080
uv run huagent-worker     # 另一个终端
# 后台开发进程的日志统一写到仓库根 logs/（已被 gitignore），例如：
#   mkdir -p logs && (cd management && uv run huagent-api > ../logs/huagent-api.log 2>&1 &)

# 客户端
cd app && npm ci && npm run dev

# 管理台
cd management-ui && npm ci && npm run dev                    # http://localhost:5173
```

只想快速跑起来（不开发）：`scripts/quickstart.sh up --email you@example.com`。

## 提交前必须通过（CI 同源）

```bash
bash scripts/check-all.sh                       # 服务端 lint/mypy/pytest + 客户端 + 管理台
bash scripts/security-scan.sh                   # 依赖与静态扫描（pip-audit / bandit / npm audit）
HUAGENT_TESTCONTAINERS=1 uv run --project management pytest -m integration -q   # 真实 PG 集成测试
cd app && CLOUD_E2E=1 MARKET_E2E=1 SYNC_E2E=1 STATS_E2E=1 npx vitest run tests/integration
```

修改了服务端接口时：

```bash
cd management && uv run python scripts/export_openapi.py    # 重新生成 openapi/openapi.json
cd ../management-ui && npm run api:gen                      # 重新生成前端类型（npm run check 会校验同源）
```

## 代码规范（摘要）

- **不加不必要的依赖**：优先标准库与既有实现；新增运行时依赖需在 PR 描述里说明理由与影响。
- **小而专注的单元**：一个函数/模块只做一件事，通过明确接口组合；避免过度抽象。
- **注释解释意图**：不重复代码字面含义；对非显而易见的取舍写清"为什么"。
- **安全默认值**：路径、ZIP、令牌、SQL 拼装等边界必须显式校验；不要在日志里出现 token/密钥/提示词/文件路径。
- **国际化**：客户端与管理台的用户可见文案一律走 `t()`（中文原文即键）；模型面向提示词保持单语言。
- **测试**：新增行为带测试（单元或集成）；修复缺陷先补一个能复现的测试。

## Pull Request 流程

1. Fork → 从 `main` 开分支（`feat/…`、`fix/…`、`docs/…`）。
2. 小步提交，提交信息用 [Conventional Commits](https://www.conventionalcommits.org/) 风格
   （`feat(scope): …`、`fix(scope): …`、`docs: …`、`chore: …`），正文说明动机与验证方式。
3. 确保上面的检查全绿；接口/设计有变动时同提交内更新文档。
4. PR 描述包含：变更内容、动机、验证方式（命令与结果）、影响面（兼容性/迁移/安全）。
5. 评审会关注：安全边界、数据生命周期、向后兼容、i18n 与文档同步。

## 发布流程（维护者）

1. 更新 `CHANGELOG.md`（中文）与 `CHANGELOG.en.md`（英文，Release 说明取自它）——把 `Unreleased` 下的条目归入新版本，并更新 `docs/delivery/release-notes.md` 的已知限制。
2. 本地验证：`bash scripts/check-all.sh` + `bash scripts/security-scan.sh`，并按 `docs/validation.md` 走一遍自验证清单。
3. 打标签并推送：`git tag v0.1.0 && git push origin v0.1.0` —— 触发 `.github/workflows/release.yml`：
   校验 → 构建 Windows/macOS 安装包（未签名）+ SHA256 → 依赖清单 → **草稿** Release。
4. 复核草稿中的校验和与产物，确认后发布；历史上游版本不要回改，回滚用新版本号。

## 报告问题

- 缺陷与功能建议：GitHub Issues（附版本、部署方式、复现步骤；服务端附 `X-Trace-Id`，客户端附诊断包）。
- 安全漏洞：**不要开公开 issue**，按 [`SECURITY.md`](SECURITY.md) 私密上报。

## 行为准则

参与本项目即表示同意遵守 [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)。
