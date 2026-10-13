"""密码哈希、JWT 与不透明令牌（design 6.10.1 / 8.1）。

- 密码：argon2id（内存 64MB、迭代 3）
- access token：JWT HS256，15 分钟，claims：sub / device_id / roles_version / iat / exp / jti
- refresh token：不透明随机串，DB 只存 sha256 哈希，旋转 + 家族撤销
"""

from __future__ import annotations

import hashlib
import re
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode

MIN_PASSWORD_LENGTH = 10
MAX_PASSWORD_LENGTH = 256

_hasher = PasswordHasher(time_cost=3, memory_cost=64 * 1024, parallelism=4, hash_len=32, salt_len=16)

# 内置弱口令小名单；生产可通过 HUAGENT_WEAK_PASSWORD_FILE 挂载完整 top-10k 名单（design 6.10.1）
_BUILTIN_WEAK_PASSWORDS = frozenset(
    {
        "1234567890",
        "12345678901",
        "123456789012",
        "password123",
        "password1234",
        "qwertyuiop",
        "qwerty123456",
        "iloveyou123",
        "admin123456",
        "administrator",
        "letmein12345",
        "welcome12345",
        "abc123456789",
        "1234567890a",
        "a1234567890",
        "P@ssw0rd123",
        "Passw0rd123",
        "1qaz2wsx3edc",
        "qazwsxedc123",
        "zhangsan123",
        "woaini1314520",
        "aa123456789",
        "1q2w3e4r5t6y",
        "000000000000",
        "111111111111",
        "123123123123",
        "888888888888",
        "666666666666",
    }
)

_EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s.]{1,63}(\.[^@\s.]{1,63})+$")

_weak_file_cache: frozenset[str] | None = None


def normalize_email(email: str) -> str:
    return email.strip().lower()


def validate_email(email: str) -> str:
    normalized = normalize_email(email)
    if not _EMAIL_RE.match(normalized):
        raise AppError(ErrorCode.VALIDATION_FAILED, "邮箱格式不正确")
    return normalized


def validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise AppError(ErrorCode.VALIDATION_FAILED, f"密码至少 {MIN_PASSWORD_LENGTH} 位")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise AppError(ErrorCode.VALIDATION_FAILED, "密码过长")
    lowered = password.lower()
    if lowered in _BUILTIN_WEAK_PASSWORDS or lowered in _weak_passwords_from_file():
        raise AppError(ErrorCode.VALIDATION_FAILED, "密码过于常见，请更换")


def _weak_passwords_from_file() -> frozenset[str]:
    global _weak_file_cache
    if _weak_file_cache is not None:
        return _weak_file_cache
    path = get_settings().weak_password_file
    values: set[str] = set()
    if path:
        try:
            with open(path, encoding="utf-8") as handle:
                values = {line.strip().lower() for line in handle if line.strip()}
        except OSError:
            values = set()
    _weak_file_cache = frozenset(values)
    return _weak_file_cache


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str | None) -> bool:
    if not password_hash:
        return False
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(password_hash)
    except InvalidHashError:
        return True


def issue_access_token(user_id: uuid.UUID, device_id: str, roles_version: int) -> tuple[str, int]:
    settings = get_settings()
    ttl = settings.access_token_ttl_seconds
    now = datetime.now(UTC)
    claims: dict[str, Any] = {
        "sub": str(user_id),
        "device_id": device_id,
        "roles_version": roles_version,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
        "jti": uuid.uuid7().hex,
    }
    token = jwt.encode(claims, settings.jwt_secret, algorithm=settings.jwt_algorithm)
    return token, ttl


def decode_access_token(token: str) -> dict[str, Any]:
    settings = get_settings()
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            options={"require": ["exp", "sub"]},
        )
    except jwt.ExpiredSignatureError as exc:
        raise AppError(ErrorCode.UNAUTHENTICATED, "登录状态已过期") from exc
    except jwt.InvalidTokenError as exc:
        raise AppError(ErrorCode.UNAUTHENTICATED, "无效的访问令牌") from exc
    return payload


def new_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
