"""密码策略、JWT 与刷新令牌哈希单测（design 6.10.1 / 8.1）。"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import jwt
import pytest

from huagent.common.errors import AppError, ErrorCode
from huagent.common.security import (
    decode_access_token,
    hash_password,
    hash_refresh_token,
    issue_access_token,
    new_refresh_token,
    validate_email,
    validate_password,
    verify_password,
)


def test_password_hash_and_verify() -> None:
    hashed = hash_password("correct-horse-battery")
    assert hashed.startswith("$argon2id$")
    assert verify_password("correct-horse-battery", hashed)
    assert not verify_password("wrong-password", hashed)
    assert not verify_password("anything", None)


def test_password_policy() -> None:
    with pytest.raises(AppError) as short:
        validate_password("short")
    assert short.value.code == ErrorCode.VALIDATION_FAILED

    with pytest.raises(AppError):
        validate_password("password123")  # 内置弱口令名单

    validate_password("Str0ng-Passphrase-2026")


def test_validate_email_normalizes_and_rejects() -> None:
    assert validate_email("  User@Example.COM ") == "user@example.com"
    for bad in ("no-at-sign", "a@b", "a b@example.com", "@example.com"):
        with pytest.raises(AppError):
            validate_email(bad)


def test_access_token_roundtrip() -> None:
    user_id = uuid.uuid7()
    token, expires_in = issue_access_token(user_id, "device-1", 7)
    assert expires_in == 900
    payload = decode_access_token(token)
    assert payload["sub"] == str(user_id)
    assert payload["device_id"] == "device-1"
    assert payload["roles_version"] == 7
    assert payload["jti"]


def test_expired_access_token_rejected() -> None:
    from huagent.common.config import get_settings

    settings = get_settings()
    now = datetime.now(UTC)
    expired = jwt.encode(
        {
            "sub": str(uuid.uuid7()),
            "device_id": "d",
            "roles_version": 0,
            "iat": int((now - timedelta(hours=1)).timestamp()),
            "exp": int((now - timedelta(minutes=1)).timestamp()),
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    with pytest.raises(AppError) as exc:
        decode_access_token(expired)
    assert exc.value.code == ErrorCode.UNAUTHENTICATED

    with pytest.raises(AppError):
        decode_access_token("not-a-jwt")


def test_refresh_token_is_opaque_and_hashed() -> None:
    token = new_refresh_token()
    assert len(token) >= 32
    assert token != new_refresh_token()
    assert len(hash_refresh_token(token)) == 64
    assert hash_refresh_token(token) == hash_refresh_token(token)
    assert hash_refresh_token(token) != hash_refresh_token(new_refresh_token())
