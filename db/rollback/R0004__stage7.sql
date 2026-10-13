-- =====================================================================
-- 回滚：R0004（对应 V0004__stage7.sql）
-- 仅用于本地/测试环境。
-- =====================================================================

DROP TABLE IF EXISTS sso_login_codes CASCADE;
DROP TABLE IF EXISTS sso_login_requests CASCADE;
ALTER TABLE identity_providers DROP COLUMN IF EXISTS allow_auto_link;

DELETE FROM schema_versions WHERE version = 'V0004';
