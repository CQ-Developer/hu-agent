"""配置守卫测试：非 local 环境必须显式提供密钥（避免示例默认值上线）。"""

from __future__ import annotations

import pytest

from huagent.common.config import Settings

VALID_SECRET = "s3cret-" + "a" * 40
VALID_MASTER_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="  # 32 字节 Base64


def test_local_env_allows_dev_defaults() -> None:
    settings = Settings(env="local")
    assert settings.jwt_secret.startswith("dev-only-change-me")


def test_non_local_requires_jwt_secret_and_master_key() -> None:
    with pytest.raises(ValueError) as error:
        Settings(env="production")
    message = str(error.value)
    assert "HUAGENT_JWT_SECRET" in message
    assert "HUAGENT_MASTER_KEY" in message


def test_short_jwt_secret_rejected() -> None:
    with pytest.raises(ValueError, match="HUAGENT_JWT_SECRET"):
        Settings(env="production", jwt_secret="short", master_key=VALID_MASTER_KEY)


def test_dev_default_jwt_secret_rejected() -> None:
    with pytest.raises(ValueError, match="HUAGENT_JWT_SECRET"):
        Settings(env="staging", jwt_secret="dev-only-change-me-0123456789abcdef", master_key=VALID_MASTER_KEY)


def test_explicit_secrets_pass() -> None:
    settings = Settings(env="production", jwt_secret=VALID_SECRET, master_key=VALID_MASTER_KEY)
    assert settings.env == "production"
