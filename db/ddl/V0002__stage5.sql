-- =====================================================================
-- hu-agent 服务端 schema：阶段 5（市场与治理）
-- 版本：V0002
-- 目标数据库：PostgreSQL 18
-- 规范：docs/design.md 6.4.5（停用/撤回原因）、6.9.2（资源状态查询）
-- 说明：V0001 已覆盖组织/团队/审批/市场表结构，本脚本只补充
--       「停用/撤回必填原因」的存储字段（下发客户端展示 + 审计）。
-- 幂等：全部使用 IF NOT EXISTS；重复执行安全。
-- =====================================================================

ALTER TABLE skills ADD COLUMN IF NOT EXISTS disabled_reason text;
ALTER TABLE mcp_servers ADD COLUMN IF NOT EXISTS disabled_reason text;
ALTER TABLE skill_versions ADD COLUMN IF NOT EXISTS revoked_reason text;
ALTER TABLE mcp_server_versions ADD COLUMN IF NOT EXISTS revoked_reason text;

-- 状态变更统一递增修订号（design 6.4.5）：重置默认值，避免手工 UPDATE 忘记 bump
ALTER TABLE skills ALTER COLUMN status_revision SET DEFAULT nextval('resource_status_revision_seq');
ALTER TABLE mcp_servers ALTER COLUMN status_revision SET DEFAULT nextval('resource_status_revision_seq');

-- =====================================================================
-- 版本记录
-- =====================================================================

INSERT INTO schema_versions (version, description, checksum)
VALUES ('V0002', '阶段 5：资源停用/撤回原因字段', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
