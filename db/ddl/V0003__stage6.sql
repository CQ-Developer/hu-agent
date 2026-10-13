-- =====================================================================
-- hu-agent 服务端 schema：阶段 6（云同步与统计）
-- 版本：V0003
-- 目标数据库：PostgreSQL 18
-- 规范：docs/design.md 6.6.2（双摘要）、6.6.3（配额与保留）、6.7.2（价格表）
-- 幂等：全部使用 IF NOT EXISTS / ON CONFLICT；重复执行安全。
-- =====================================================================

-- 清单摘要（与内容摘要分开：manifest_digest 用于冲突检测，digest 用于完整性校验）
ALTER TABLE workspace_snapshots ADD COLUMN IF NOT EXISTS manifest_digest text;

-- 对象存储 key（预签名直传需要先确定 key；skill_versions 同样使用 object_key）
ALTER TABLE workspace_snapshots ADD COLUMN IF NOT EXISTS object_key text;
UPDATE workspace_snapshots SET object_key = '' WHERE object_key IS NULL;

-- 默认系统设置（配额与保留；管理台可在阶段 6-07 / 5-09 调整）
INSERT INTO system_settings (key, value) VALUES
  ('quota.user_bytes', '10737418240'::jsonb),      -- 10 GB
  ('quota.team_bytes', '107374182400'::jsonb),     -- 100 GB
  ('snapshot.retention', '20'::jsonb),             -- 保留最近 20 个版本
  ('usage.retention_days', '90'::jsonb)            -- 原始用量事件保留 90 天
ON CONFLICT (key) DO NOTHING;

-- =====================================================================
-- 版本记录
-- =====================================================================

INSERT INTO schema_versions (version, description, checksum)
VALUES ('V0003', '阶段 6：快照清单摘要与默认配额设置', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
