-- 开发种子数据（仅本地/测试环境；生产不使用）
-- 执行：docker compose -f docker/compose.yaml exec -T postgres \
--         psql -U huagent -d huagent -v ON_ERROR_STOP=1 < db/seed/dev_seed.sql

INSERT INTO system_settings (key, value) VALUES
  ('client.min_version',            '"0.1.0"'::jsonb),
  ('quota.user.storage_bytes',      '10737418240'::jsonb),   -- 单用户 10 GB
  ('quota.team.storage_bytes',      '107374182400'::jsonb),  -- 单团队 100 GB
  ('snapshot.retention_versions',   '20'::jsonb),
  ('usage.raw_retention_days',      '90'::jsonb),
  ('usage.daily_retention_months',  '24'::jsonb),
  ('audit.retention_days',          '365'::jsonb),
  ('resource.enforcement_mode',     '"cooperative"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- 系统管理员账号不在此创建（需要 argon2id 哈希，由服务端初始化命令生成，见 design 6.2.1）。
