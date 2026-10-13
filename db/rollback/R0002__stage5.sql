-- =====================================================================
-- 回滚：R0002（对应 V0002__stage5.sql）
-- 仅用于本地/测试环境；删除阶段 5 新增的字段。
-- =====================================================================

ALTER TABLE skills DROP COLUMN IF EXISTS disabled_reason;
ALTER TABLE mcp_servers DROP COLUMN IF EXISTS disabled_reason;
ALTER TABLE skill_versions DROP COLUMN IF EXISTS revoked_reason;
ALTER TABLE mcp_server_versions DROP COLUMN IF EXISTS revoked_reason;

DELETE FROM schema_versions WHERE version = 'V0002';
