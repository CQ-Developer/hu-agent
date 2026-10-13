-- =====================================================================
-- hu-agent 服务端 schema：阶段 7（SSO / OIDC，design 6.12）
-- 版本：V0004
-- 目标数据库：PostgreSQL 18
-- 说明：V0001 已有 identity_providers / user_identities；
--       本脚本补充「登录请求 / 一次性 code」存储与更严格绑定开关。
-- 幂等：IF NOT EXISTS / 重复执行安全。
-- =====================================================================

-- 更严格模式：默认允许按邮箱自动绑定已有本地账号（design 6.12.4 第 3 条）
ALTER TABLE identity_providers ADD COLUMN IF NOT EXISTS allow_auto_link boolean NOT NULL DEFAULT true;

-- 待完成的 SSO 登录请求：state / 服务端 PKCE verifier / 客户端回跳参数
CREATE TABLE IF NOT EXISTS sso_login_requests (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  provider_id           uuid NOT NULL REFERENCES identity_providers (id) ON DELETE CASCADE,
  idp_state_hash        text NOT NULL UNIQUE,             -- 服务端生成的 state（仅存哈希）
  code_verifier_enc     text NOT NULL,                    -- 服务端与 IdP 之间的 PKCE verifier（主密钥加密）
  nonce                 text NOT NULL,
  client_state          text NOT NULL,                    -- 客户端 state，回调原样带回
  redirect_uri          text NOT NULL,
  code_challenge        text NOT NULL,                    -- 客户端对 exchange 的 PKCE challenge
  code_challenge_method text NOT NULL DEFAULT 'S256',
  device_id             text,
  platform              text,
  app_version           text,
  device_name           text,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'completed', 'failed', 'expired')),
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sso_requests_provider ON sso_login_requests (provider_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sso_requests_expires ON sso_login_requests (expires_at) WHERE status = 'pending';

-- 一次性登录 code（发给客户端，60s 内单次使用；exchange 时校验 PKCE）
CREATE TABLE IF NOT EXISTS sso_login_codes (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  code_hash    text NOT NULL UNIQUE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider_id  uuid NOT NULL REFERENCES identity_providers (id) ON DELETE CASCADE,
  code_challenge        text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  device_id    text,
  platform     text,
  app_version  text,
  device_name  text,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sso_codes_expires ON sso_login_codes (expires_at) WHERE used_at IS NULL;

-- =====================================================================
-- 版本记录
-- =====================================================================

INSERT INTO schema_versions (version, description, checksum)
VALUES ('V0004', '阶段 7：SSO 登录请求与一次性 code', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
