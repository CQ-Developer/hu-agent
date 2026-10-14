-- =====================================================================
-- R0005：回滚用户数据生命周期（design 6.10.5）
-- 注意：回滚会丢失注销申请时间与清理标记（已清理账号不会因此恢复 PII）
-- =====================================================================

DROP INDEX IF EXISTS idx_users_pending_deletion;

ALTER TABLE users DROP COLUMN IF EXISTS purged_at;
ALTER TABLE users DROP COLUMN IF EXISTS deletion_requested_at;

DELETE FROM system_settings WHERE key IN ('usage.daily_retention_days', 'account.deletion_grace_days');

DELETE FROM schema_versions WHERE version = 'V0005';
