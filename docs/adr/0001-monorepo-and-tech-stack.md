# ADR 0001：monorepo 与后端技术栈

- 状态：已接受
- 日期：2025-10-13（v1.2 技术栈调整后）

## 背景

单人开发，交付对象为企业。三个组件（Electron 客户端、服务端、管理台）需要频繁同步接口契约与数据模型。

## 决策

1. **采用 monorepo**：`app/`、`management/`、`management-ui/`、`db/`、`openapi/`、`scripts/` 同仓维护，一次提交可以同时改契约与实现。
2. **后端为 Python 3.14 + FastAPI + uv**（原方案为 Spring Boot 4 + Java 25，单人开发语境下调整）：
   - FastAPI 自动生成 OpenAPI 3.1，满足"契约先行"；
   - Pydantic v2 统一校验与序列化；
   - uv 统一依赖锁定与 Python 运行时（`uv.lock` 入库）。
3. **数据访问为 SQLAlchemy 2.0（async）+ psycopg 3**，复杂查询直接写参数化 SQL。
4. **Schema 仍由编号 DDL 脚本手工维护**（不使用 Alembic/Flyway）：应用启动只校验 `schema_versions`，不执行 DDL。

## 后果

- 契约一致性靠 monorepo + CI 的 OpenAPI 检查，不依赖多仓同步；
- Python 3.14 属较新版本，需在阶段 0 用 `uv sync` 实测关键依赖并锁定版本（见 `docs/plan.md` 0-01）；
- 单人开发下无代码评审，靠 CI 门禁、关键路径单测与 ADR 记录补偿（见 `docs/plan.md` 3.3）。
