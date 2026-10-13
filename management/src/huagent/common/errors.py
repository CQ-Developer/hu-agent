"""统一错误码与异常，对应 docs/design.md 6.9.1。"""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class ErrorCode(StrEnum):
    UNAUTHENTICATED = "UNAUTHENTICATED"
    REFRESH_REVOKED = "REFRESH_REVOKED"
    FORBIDDEN = "FORBIDDEN"
    NOT_FOUND = "NOT_FOUND"
    CONFLICT = "CONFLICT"
    VERSION_CONFLICT = "VERSION_CONFLICT"
    NAME_CONFLICT = "NAME_CONFLICT"
    VALIDATION_FAILED = "VALIDATION_FAILED"
    PACKAGE_INVALID = "PACKAGE_INVALID"
    QUOTA_EXCEEDED = "QUOTA_EXCEEDED"
    RATE_LIMITED = "RATE_LIMITED"
    ACCOUNT_DISABLED = "ACCOUNT_DISABLED"
    CLIENT_TOO_OLD = "CLIENT_TOO_OLD"
    INTERNAL = "INTERNAL"


DEFAULT_STATUS: dict[ErrorCode, int] = {
    ErrorCode.UNAUTHENTICATED: 401,
    ErrorCode.REFRESH_REVOKED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.CONFLICT: 409,
    ErrorCode.VERSION_CONFLICT: 409,
    ErrorCode.NAME_CONFLICT: 409,
    ErrorCode.VALIDATION_FAILED: 422,
    ErrorCode.PACKAGE_INVALID: 422,
    ErrorCode.QUOTA_EXCEEDED: 402,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.ACCOUNT_DISABLED: 403,
    ErrorCode.CLIENT_TOO_OLD: 426,
    ErrorCode.INTERNAL: 500,
}


class AppError(Exception):
    """业务异常；由 API 层统一转换为标准错误响应。"""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code or DEFAULT_STATUS[code]
        self.details = details or {}
