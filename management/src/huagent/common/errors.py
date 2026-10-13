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
    METHOD_NOT_ALLOWED = "METHOD_NOT_ALLOWED"
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
    ErrorCode.METHOD_NOT_ALLOWED: 405,
    ErrorCode.INTERNAL: 500,
}

# HTTP 状态码 -> 业务错误码（用于 FastAPI/Starlette 自身抛出的异常）
_STATUS_TO_CODE: dict[int, ErrorCode] = {
    400: ErrorCode.VALIDATION_FAILED,
    401: ErrorCode.UNAUTHENTICATED,
    402: ErrorCode.QUOTA_EXCEEDED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    405: ErrorCode.METHOD_NOT_ALLOWED,
    409: ErrorCode.CONFLICT,
    422: ErrorCode.VALIDATION_FAILED,
    426: ErrorCode.CLIENT_TOO_OLD,
    429: ErrorCode.RATE_LIMITED,
}


def code_for_status(status_code: int) -> ErrorCode:
    if status_code in _STATUS_TO_CODE:
        return _STATUS_TO_CODE[status_code]
    return ErrorCode.INTERNAL if status_code >= 500 else ErrorCode.VALIDATION_FAILED


class AppError(Exception):
    """业务异常；由 API 层统一转换为标准错误响应。"""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        status_code: int | None = None,
        details: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code or DEFAULT_STATUS[code]
        self.details = details or {}
        self.headers = headers or {}
