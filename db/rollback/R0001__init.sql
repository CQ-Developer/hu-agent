-- =====================================================================
-- 回滚：R0001（对应 V0001__init.sql）
-- 警告：会删除全部 schema 与数据，仅用于本地/测试环境。
-- 执行：docker compose -f docker/compose.yaml exec -T postgres \
--         psql -U huagent -d huagent -v ON_ERROR_STOP=1 < db/rollback/R0001__init.sql
-- =====================================================================

DROP TABLE IF EXISTS job_runs CASCADE;
DROP TABLE IF EXISTS system_settings CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS activation_reports CASCADE;
DROP TABLE IF EXISTS model_prices CASCADE;
DROP TABLE IF EXISTS usage_daily CASCADE;
DROP TABLE IF EXISTS usage_events CASCADE;   -- 含所有分区
DROP TABLE IF EXISTS workspace_snapshots CASCADE;
DROP TABLE IF EXISTS workspaces CASCADE;
DROP TABLE IF EXISTS mcp_server_versions CASCADE;
DROP TABLE IF EXISTS mcp_servers CASCADE;
DROP TABLE IF EXISTS skill_versions CASCADE;
DROP TABLE IF EXISTS skills CASCADE;
DROP TABLE IF EXISTS user_identities CASCADE;
DROP TABLE IF EXISTS identity_providers CASCADE;
DROP TABLE IF EXISTS approval_requests CASCADE;
DROP TABLE IF EXISTS invitations CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS org_members CASCADE;
DROP TABLE IF EXISTS orgs CASCADE;
DROP TABLE IF EXISTS refresh_tokens CASCADE;
DROP TABLE IF EXISTS devices CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS schema_versions CASCADE;
DROP SEQUENCE IF EXISTS resource_status_revision_seq;
DROP FUNCTION IF EXISTS set_updated_at();
