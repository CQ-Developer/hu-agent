-- =====================================================================
-- hu-agent 服务端初始 schema
-- 版本：V0001
-- 目标数据库：PostgreSQL 18
-- 规范：docs/design.md 6.8；执行方式：scripts/ddl-apply.sh（应用不自动执行 DDL）
-- 约定：
--   * 主键统一 UUIDv7（PG18 内置 uuidv7()），usage_events 例外（分区表，identity）
--   * updated_at 由触发器维护
--   * 状态字段用 CHECK 约束枚举；软删通过 status='deleted' 表达
--   * 本脚本可被 JDBC/psql 直接执行；末尾自行写入 schema_versions
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_versions (
  version     text PRIMARY KEY,
  description text NOT NULL,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  applied_by  text NOT NULL DEFAULT current_user
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- skills.status_revision / mcp_servers.status_revision 共用的全局修订号序列（design 6.4.5）
CREATE SEQUENCE IF NOT EXISTS resource_status_revision_seq;

-- =====================================================================
-- 一、账号与认证（design 6.8.2）
-- =====================================================================

CREATE TABLE IF NOT EXISTS users (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  email             citext NOT NULL UNIQUE,
  password_hash     text,                                  -- SSO 用户可为空
  display_name      text NOT NULL,
  avatar_url        text,
  locale            text NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('zh-CN', 'en-US')),
  is_system_admin   boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified_at timestamptz,
  roles_version     integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_users_status ON users (status);

CREATE TABLE IF NOT EXISTS devices (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id    text NOT NULL,                              -- 客户端生成的设备指纹 UUID
  platform     text NOT NULL CHECK (platform IN ('win32', 'darwin', 'linux')),
  app_version  text NOT NULL,
  name         text,
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id      text NOT NULL,
  token_hash     text NOT NULL UNIQUE,
  family_id      uuid NOT NULL,                            -- 旋转链；重放时撤销整个 family
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  replaced_by_id uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (family_id);

-- =====================================================================
-- 二、组织与团队（design 6.2 / 6.3）
-- =====================================================================

CREATE TABLE IF NOT EXISTS orgs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL,
  slug        citext NOT NULL UNIQUE,
  description text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'deleted')),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_orgs_updated_at
  BEFORE UPDATE ON orgs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS org_members (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id    uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON org_members (user_id);

CREATE TABLE IF NOT EXISTS teams (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id      uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);
CREATE OR REPLACE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_teams_org ON teams (org_id, status);

CREATE TABLE IF NOT EXISTS team_members (
  id        uuid PRIMARY KEY DEFAULT uuidv7(),
  team_id   uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status    text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members (user_id);

CREATE TABLE IF NOT EXISTS invitations (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  type         text NOT NULL CHECK (type IN ('org', 'team')),
  org_id       uuid REFERENCES orgs (id) ON DELETE CASCADE,
  team_id      uuid REFERENCES teams (id) ON DELETE CASCADE,
  email        citext NOT NULL,
  user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  role         text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  token_hash   text NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  expires_at   timestamptz NOT NULL,
  accepted_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'org' AND team_id IS NULL) OR (type = 'team' AND team_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (email, status);
CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations (org_id, status);
CREATE INDEX IF NOT EXISTS idx_invitations_team ON invitations (team_id, status);

CREATE TABLE IF NOT EXISTS approval_requests (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  type           text NOT NULL CHECK (type IN ('org_create', 'team_create', 'skill_version_publish', 'mcp_version_publish')),
  requester_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  org_id         uuid REFERENCES orgs (id) ON DELETE CASCADE,
  team_id        uuid REFERENCES teams (id) ON DELETE CASCADE,
  target_type    text,
  target_id      text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,       -- 提交快照，供审核与回溯
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'stale')),
  reviewer_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  review_comment text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  decided_at     timestamptz
);
-- 同一目标同时只允许一个 pending 审批（design 6.3.1）
CREATE UNIQUE INDEX IF NOT EXISTS uq_approval_pending_target
  ON approval_requests (target_type, target_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_org ON approval_requests (org_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_team ON approval_requests (team_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_requester ON approval_requests (requester_id, created_at DESC);

-- =====================================================================
-- 三、SSO 身份源（design 6.12）
-- =====================================================================

CREATE TABLE IF NOT EXISTS identity_providers (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  name                 text NOT NULL UNIQUE,
  type                 text NOT NULL DEFAULT 'oidc' CHECK (type IN ('oidc')),
  issuer_url           text NOT NULL,
  client_id            text NOT NULL,
  client_secret_enc    text,                               -- 主密钥 AES-GCM 加密后的密文（HUAGENT_MASTER_KEY）
  scopes               text NOT NULL DEFAULT 'openid profile email',
  enabled              boolean NOT NULL DEFAULT false,
  allowed_email_domains text[] NOT NULL DEFAULT '{}',
  auto_join_org_id     uuid REFERENCES orgs (id) ON DELETE SET NULL,
  created_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_identity_providers_updated_at
  BEFORE UPDATE ON identity_providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS user_identities (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL REFERENCES identity_providers (id) ON DELETE CASCADE,
  subject       text NOT NULL,
  email         citext,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, subject)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities (user_id);

-- =====================================================================
-- 四、Skill / MCP 市场（design 6.4 / 6.5 / 6.4.5）
-- =====================================================================

CREATE TABLE IF NOT EXISTS skills (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id                     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  team_id                    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  name                       text NOT NULL,
  slug                       text NOT NULL,
  description                text NOT NULL DEFAULT '',
  tags                       text[] NOT NULL DEFAULT '{}',
  status                     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'delisted', 'deleted', 'disabled')),
  status_revision            bigint NOT NULL DEFAULT nextval('resource_status_revision_seq'),
  latest_published_version_id uuid,                        -- FK 在 skill_versions 建表后补
  created_by                 uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug)
);
CREATE OR REPLACE TRIGGER trg_skills_updated_at
  BEFORE UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_skills_team ON skills (team_id, status);
CREATE INDEX IF NOT EXISTS idx_skills_tags ON skills USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_skills_name_trgm ON skills USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_skills_desc_trgm ON skills USING gin (description gin_trgm_ops);

CREATE TABLE IF NOT EXISTS skill_versions (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  skill_id     uuid NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
  version      text NOT NULL,                              -- semver
  digest       text NOT NULL,                              -- sha256
  object_key   text NOT NULL,                              -- skills/{orgId}/{teamId}/{skillId}/{version}/{sha256}.hskill
  size_bytes   bigint NOT NULL DEFAULT 0,
  file_count   integer NOT NULL DEFAULT 0,
  manifest     jsonb NOT NULL DEFAULT '{}'::jsonb,         -- front matter + 文件清单
  changelog    text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'superseded', 'revoked')),
  review_id    uuid REFERENCES approval_requests (id) ON DELETE SET NULL,
  download_count integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);
CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions (skill_id, status);

ALTER TABLE skills
  ADD CONSTRAINT fk_skills_latest_version
  FOREIGN KEY (latest_published_version_id) REFERENCES skill_versions (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                         uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id                     uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  team_id                    uuid NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
  name                       text NOT NULL,
  slug                       text NOT NULL,
  description                text NOT NULL DEFAULT '',
  tags                       text[] NOT NULL DEFAULT '{}',
  status                     text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'delisted', 'deleted', 'disabled')),
  status_revision            bigint NOT NULL DEFAULT nextval('resource_status_revision_seq'),
  latest_published_version_id uuid,                        -- FK 在 mcp_server_versions 建表后补
  created_by                 uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, slug)
);
CREATE OR REPLACE TRIGGER trg_mcp_servers_updated_at
  BEFORE UPDATE ON mcp_servers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_mcp_servers_team ON mcp_servers (team_id, status);

CREATE TABLE IF NOT EXISTS mcp_server_versions (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  mcp_server_id   uuid NOT NULL REFERENCES mcp_servers (id) ON DELETE CASCADE,
  version         integer NOT NULL,
  transport       text NOT NULL CHECK (transport IN ('stdio', 'sse', 'http')),
  config_template jsonb NOT NULL DEFAULT '{}'::jsonb,
  env_schema      jsonb NOT NULL DEFAULT '[]'::jsonb,      -- 只声明，不存密钥值
  docs_md         text,
  changelog       text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'superseded', 'revoked')),
  review_id       uuid REFERENCES approval_requests (id) ON DELETE SET NULL,
  created_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mcp_server_id, version)
);
CREATE INDEX IF NOT EXISTS idx_mcp_server_versions_server ON mcp_server_versions (mcp_server_id, status);

ALTER TABLE mcp_servers
  ADD CONSTRAINT fk_mcp_servers_latest_version
  FOREIGN KEY (latest_published_version_id) REFERENCES mcp_server_versions (id) ON DELETE SET NULL;

-- =====================================================================
-- 五、工作空间与快照（design 6.6）
-- =====================================================================

CREATE TABLE IF NOT EXISTS workspaces (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,   -- D12：个人所有
  team_id            uuid REFERENCES teams (id) ON DELETE SET NULL,           -- 仅用于配额与统计归属
  name               text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  latest_snapshot_id uuid,                                                    -- FK 在 workspace_snapshots 建表后补
  storage_bytes      bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces (user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_team ON workspaces (team_id);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  version      integer NOT NULL,
  status       text NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'active', 'aborted')),
  digest       text,                                       -- sha256（complete 后写入）
  manifest     jsonb NOT NULL DEFAULT '{}'::jsonb,
  size_bytes   bigint NOT NULL DEFAULT 0,
  file_count   integer NOT NULL DEFAULT 0,
  device_id    text,
  comment      text,
  pinned       boolean NOT NULL DEFAULT false,
  encrypted    boolean NOT NULL DEFAULT false,             -- D4 预留，v1 恒为 false
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, version)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_workspace ON workspace_snapshots (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_status ON workspace_snapshots (status);

ALTER TABLE workspaces
  ADD CONSTRAINT fk_workspaces_latest_snapshot
  FOREIGN KEY (latest_snapshot_id) REFERENCES workspace_snapshots (id) ON DELETE SET NULL;

-- =====================================================================
-- 六、用量与统计（design 6.7）
-- =====================================================================

-- 按 occurred_at 月分区；唯一约束必须包含分区键，故为 (event_id, occurred_at)。
-- 客户端重试发送同一事件时 occurred_at 不变，幂等仍成立。
CREATE TABLE IF NOT EXISTS usage_events (
  id                  bigint GENERATED BY DEFAULT AS IDENTITY,
  event_id            uuid NOT NULL,
  user_id             uuid,
  org_id              uuid,
  team_id             uuid,
  workspace_id        uuid,
  device_id           text,
  session_id_hash     text,
  purpose             text NOT NULL DEFAULT 'primary' CHECK (purpose IN ('primary', 'fast')),
  provider            text NOT NULL,
  model               text NOT NULL,
  input_tokens        bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens       bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens   bigint NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens  bigint NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  reasoning_tokens    bigint NOT NULL DEFAULT 0 CHECK (reasoning_tokens >= 0),
  requests            integer NOT NULL DEFAULT 1 CHECK (requests >= 0),
  duration_ms         integer,
  status              text NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'error')),
  error_code          text,
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  aggregated_at       timestamptz,
  PRIMARY KEY (id, occurred_at),
  UNIQUE (event_id, occurred_at)
) PARTITION BY RANGE (occurred_at);
-- 高写入量：不建外键，归属在应用层校验（design 6.7.1）
CREATE INDEX IF NOT EXISTS idx_usage_events_user ON usage_events (user_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_org ON usage_events (org_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_team ON usage_events (team_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_pending ON usage_events (occurred_at) WHERE aggregated_at IS NULL;

-- 初始分区：当月 + 未来 5 个月（后续由 worker 维护，design 6.11）
DO $$
DECLARE
  base date := date_trunc('month', now())::date;
  i    integer;
  part text;
BEGIN
  FOR i IN 0..5 LOOP
    part := 'usage_events_' || to_char(base + (i || ' month')::interval, 'YYYYMM');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
      part,
      base + (i || ' month')::interval,
      base + ((i + 1) || ' month')::interval
    );
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS usage_daily (
  id                 bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  day                date NOT NULL,
  user_id            uuid,
  org_id             uuid,
  team_id            uuid,
  provider           text NOT NULL,
  model              text NOT NULL,
  input_tokens       bigint NOT NULL DEFAULT 0,
  output_tokens      bigint NOT NULL DEFAULT 0,
  cache_read_tokens  bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  requests           bigint NOT NULL DEFAULT 0,
  errors             bigint NOT NULL DEFAULT 0,
  estimated_cost     numeric(18, 6) NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_usage_daily_dims
  ON usage_daily (day, user_id, org_id, team_id, provider, model) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_usage_daily_user ON usage_daily (user_id, day);
CREATE INDEX IF NOT EXISTS idx_usage_daily_org ON usage_daily (org_id, day);
CREATE INDEX IF NOT EXISTS idx_usage_daily_team ON usage_daily (team_id, day);

CREATE TABLE IF NOT EXISTS model_prices (
  provider            text NOT NULL,
  model               text NOT NULL,
  currency            text NOT NULL DEFAULT 'USD',
  input_per_1k        numeric(18, 6) NOT NULL DEFAULT 0,
  output_per_1k       numeric(18, 6) NOT NULL DEFAULT 0,
  cache_read_per_1k   numeric(18, 6) NOT NULL DEFAULT 0,
  cache_write_per_1k  numeric(18, 6) NOT NULL DEFAULT 0,
  effective_from      date NOT NULL,
  PRIMARY KEY (provider, model, effective_from)
);

CREATE TABLE IF NOT EXISTS activation_reports (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id       text NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('global', 'workspace')),
  workspace_id    uuid REFERENCES workspaces (id) ON DELETE CASCADE,
  resource_type   text NOT NULL CHECK (resource_type IN ('skill', 'mcp')),
  resource_source text NOT NULL CHECK (resource_source IN ('market', 'local')),
  ref_id          uuid,
  resource_key    text NOT NULL,                           -- 唯一键：market 用 refId，local 用 name
  name            text NOT NULL,
  version         text,
  enabled         boolean NOT NULL DEFAULT false,
  reported_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'global' AND workspace_id IS NULL) OR (scope = 'workspace' AND workspace_id IS NOT NULL))
);
-- 服务端按 (user_id, device_id, scope, workspace_id, type, key) upsert；写前删同设备同作用域旧行由应用层保证
CREATE UNIQUE INDEX IF NOT EXISTS uq_activation_reports_dims
  ON activation_reports (user_id, device_id, scope, workspace_id, resource_type, resource_key) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS idx_activation_reports_ref ON activation_reports (resource_type, ref_id);
CREATE INDEX IF NOT EXISTS idx_activation_reports_user ON activation_reports (user_id);

-- =====================================================================
-- 七、平台（审计 / 通知 / 设置 / 任务）
-- =====================================================================

CREATE TABLE IF NOT EXISTS audit_logs (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  org_id      uuid,
  actor_id    uuid,
  actor_ip    inet,
  user_agent  text,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs (action, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL DEFAULT '',
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- worker 定时任务幂等记录（design 6.11）
CREATE TABLE IF NOT EXISTS job_runs (
  id          bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  job_id      text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error       text
);

-- =====================================================================
-- 八、版本记录
-- =====================================================================

INSERT INTO schema_versions (version, description, checksum)
VALUES ('V0001', '初始 schema：账号/组织/市场/同步/统计/平台', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
