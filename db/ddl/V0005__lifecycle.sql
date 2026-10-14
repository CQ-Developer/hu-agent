-- =====================================================================
-- V0005：用户数据生命周期（design 6.10.5）
--   - 注销申请时间与完成时间（30 天宽限期后硬删 PII）
--   - 保留策略默认值：usage_daily 24 个月、账号注销宽限期 30 天
-- =====================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS purged_at timestamptz;

-- 待清理账号的扫描索引（仅索引未完成注销的行）
CREATE INDEX IF NOT EXISTS idx_users_pending_deletion
  ON users (deletion_requested_at)
  WHERE deletion_requested_at IS NOT NULL AND purged_at IS NULL;

INSERT INTO system_settings (key, value) VALUES
  ('usage.daily_retention_days', '730'::jsonb),   -- usage_daily 保留 24 个月（design 6.10.5）
  ('account.deletion_grace_days', '30'::jsonb)    -- 注销宽限期（宽限期内可由运维恢复）
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 版本记录
-- =====================================================================

INSERT INTO schema_versions (version, description, checksum)
VALUES ('V0005', '用户数据生命周期：注销申请与 PII 清理标记', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
