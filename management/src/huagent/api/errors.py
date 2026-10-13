"""统一错误响应：{code, message, details, traceId}（design 6.9.1）。"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from huagent.api.middleware import get_trace_id
from huagent.common.errors import AppError, ErrorCode


def error_payload(
    code: ErrorCode,
    message: str,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "code": str(code),
        "message": message,
        "details": details or {},
        "traceId": get_trace_id(),
    }


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=error_payload(exc.code, exc.message, exc.details),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content=error_payload(
                ErrorCode.VALIDATION_FAILED,
                "请求参数校验失败",
                {"errors": exc.errors()},
            ),
        )
