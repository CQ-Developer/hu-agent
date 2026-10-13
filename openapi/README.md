# openapi

服务端契约产物目录（OpenAPI 3.1）。

- **来源**：`management/` 的 FastAPI 应用自动生成（设计见 `docs/design.md` 6.9）。
- **生成**：`cd management && uv run python scripts/export_openapi.py`，产物写入本目录 `openapi.json` 并提交入库。
- **用途**：
  1. 客户端与管理台用 `openapi-typescript` 生成 TypeScript 调用代码（阶段 4/5 接入）；
  2. CI 对比两次提交做破坏性变更检测（计划接入 `oasdiff`）；
  3. 作为接口评审与冻结的基线。
- **纪律**：不要手改 `openapi.json`（由代码生成）；改接口请修改服务端路由/模型后重新导出。

当前状态：已生成 `openapi.json`（阶段 0-04 验收）。
