"""阶段 0 冒烟：应用可创建、健康检查可访问、traceId 返回。"""

from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from huagent.api.app import create_app


async def test_health_ok_and_trace_id() -> None:
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/system/health", headers={"X-Trace-Id": "test-trace"})

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.headers["x-trace-id"] == "test-trace"


async def test_unknown_route_returns_unified_error() -> None:
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/v1/not-exists")

    assert response.status_code == 404
    body = response.json()
    assert body["code"] == "NOT_FOUND"
    assert body["traceId"] == response.headers["x-trace-id"]
