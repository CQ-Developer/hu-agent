## 变更内容

<!-- 一句话说明改了什么 -->

## 动机

<!-- 为什么需要这个改动；关联 issue：# -->

## 验证方式

<!-- 贴出实际运行的命令与结果（不要只写"测试通过"） -->

- [ ] `bash scripts/check-all.sh`
- [ ] `bash scripts/security-scan.sh`
- [ ] `HUAGENT_TESTCONTAINERS=1 uv run --project management pytest -m integration -q`
- [ ] 端到端（如涉及）：`CLOUD_E2E=1 MARKET_E2E=1 SYNC_E2E=1 STATS_E2E=1 npx vitest run tests/integration`

## 影响面

- 兼容性：<!-- 是否破坏现有接口/数据；是否需要迁移 -->
- 安全：<!-- 权限、路径、密钥、审计相关的影响 -->
- 文档同步（附录 F 硬性要求）：
  - [ ] 设计与决策变更已同步 `docs/`（design/plan/ADR）
  - [ ] 数据库结构变更已新增 `db/ddl/V*.sql` 与 `db/rollback/R*.sql`
  - [ ] 接口变更已重新生成 `openapi/openapi.json` 与前端类型（`npm run api:gen`）
  - [ ] 用户可见文案已双语（zh-CN / en-US）

## 自查

- [ ] 没有引入不必要的依赖（如引入，已在上面说明理由与影响）
- [ ] 新增/修改行为有测试覆盖
- [ ] 日志与示例中不含 token、密钥、提示词、真实用户数据
