"""请求链路 traceId 与 HTTP 指标（Prometheus）。"""

from __future__ import annotations

import contextvars
import time
import uuid

from starlette.types import ASGIApp, Message, Receive, Scope, Send

from huagent.common.metrics import HTTP_DURATION, HTTP_REQUESTS

_trace_id: contextvars.ContextVar[str] = contextvars.ContextVar("trace_id", default="")


def get_trace_id() -> str:
    return _trace_id.get()


class TraceIdMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        trace_id = _header(scope, b"x-trace-id") or uuid.uuid7().hex
        token = _trace_id.set(trace_id)

        async def send_with_trace(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                headers.append((b"x-trace-id", trace_id.encode("ascii")))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_with_trace)
        finally:
            _trace_id.reset(token)


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers", []):
        if key == name:
            return str(value.decode("latin-1"))
    return None


class MetricsMiddleware:
    """记录 HTTP 指标。标签用**路由模板**（非具体路径/ID）以避免基数爆炸。"""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        status = 500

        async def send_with_status(message: Message) -> None:
            nonlocal status
            if message["type"] == "http.response.start":
                status = int(message["status"])
            await send(message)

        try:
            await self.app(scope, receive, send_with_status)
        finally:
            template = _route_template(scope)
            # 指标端点自身不计入，避免采集行为污染业务指标
            if not template.endswith("/metrics"):
                method = scope.get("method", "-")
                HTTP_REQUESTS.inc(method=method, path=template, status=str(status))
                HTTP_DURATION.observe(time.perf_counter() - started, method=method, path=template)


def _route_template(scope: Scope) -> str:
    """生成完整路由模板（含 include_router 前缀），路径参数值归一为 {name} 以避免基数爆炸。"""
    if scope.get("route") is None:
        return "unmatched"
    path = scope.get("path") or "unmatched"
    for name, value in (scope.get("path_params") or {}).items():
        if value:
            path = path.replace(str(value), "{" + name + "}", 1)
    return path
