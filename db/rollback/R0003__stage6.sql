-- =====================================================================
-- 回滚：R0003（对应 V0003__stage6.sql）
-- 仅用于本地/测试环境。
-- =====================================================================

ALTER TABLE workspace_snapshots DROP COLUMN IF EXISTS manifest_digest;
ALTER TABLE workspace_snapshots DROP COLUMN IF EXISTS object_key;

DELETE FROM system_settings WHERE key IN ('quota.user_bytes', 'quota.team_bytes', 'snapshot.retention', 'usage.retention_days');
DELETE FROM schema_versions WHERE version = 'V0003';
