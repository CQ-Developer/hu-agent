-- =====================================================================
-- V0006：系统区用户管理（design 7.2）与一次性密码重置令牌（design 6.10.1）
--   - password_reset_tokens：仅存 token 哈希（明文只返回一次）
--   - 管理员在管理台发起重置 → 用户通过公开页设置新密码
--   - 自助「忘记密码」（邮件投递）留待邮件通道批次，复用同一张表
-- =====================================================================

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  issued_by   uuid REFERENCES users (id) ON DELETE SET NULL,   -- 管理员发起时记录；自助流程为 NULL
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 发放/清理按用户维度查询（同一时间每个用户最多一个未使用令牌）
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id, used_at);

-- =====================================================================
-- 版本记录
-- =====================================================================

INSERT INTO schema_versions (version, description, checksum)
VALUES ('V0006', '系统区用户管理：一次性密码重置令牌', 'sha256:pending')
ON CONFLICT (version) DO NOTHING;
