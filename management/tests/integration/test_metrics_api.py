"""集成测试：/metrics 端点（真实 PG18 + 应用内采集）。

默认跳过（需要 Docker）；运行：
    HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
"""

from __future__ import annotations

import os
import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import psycopg
import pytest
from httpx import ASGITransport, AsyncClient
from testcontainers.community.postgres import PostgresContainer

from huagent.api.app import create_app

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("HUAGENT_TESTCONTAINERS") != "1",
        reason="需要 Docker；设置 HUAGENT_TESTCONTAINERS=1 后运行",
    ),
]

DDL_DIR = Path(__file__).resolve().parents[3] / "db" / "ddl"


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    with PostgresContainer("postgres:18-alpine") as postgres:
        url = postgres.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url) as conn:
            for ddl in sorted(DDL_DIR.glob("V*.sql")):
                conn.execute(ddl.read_text(encoding="utf-8"))
        yield url


@pytest.fixture
async def client(database_url: str, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    if sys.platform == "win32":
        import asyncio
        import selectors

        asyncio.set_event_loop(asyncio.SelectorEventLoop(selectors.SelectSelector()))

    monkeypatch.setenv("HUAGENT_DATABASE_URL", database_url.replace("postgresql://", "postgresql+psycopg://"))
    monkeypatch.setenv("HUAGENT_SCHEMA_CHECK_ENABLED", "false")
    monkeypatch.setenv("HUAGENT_METRICS_TOKEN", "metrics-token-test")

    from huagent.api.routes.system import COLLECT_ERRORS
    from huagent.common.config import get_settings
    from huagent.domain.db import dispose_engine

    get_settings.cache_clear()
    before = COLLECT_ERRORS.value()
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        http_client.headers["authorization"] = "Bearer metrics-token-test"
        yield http_client
    assert COLLECT_ERRORS.value() == before, "采集数据库指标不应失败"
    await dispose_engine()
    get_settings.cache_clear()


async def test_metrics_exposes_build_and_db_gauges(client: AsyncClient, database_url: str) -> None:
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "INSERT INTO users (email, password_hash, display_name) VALUES ('metrics@example.com', 'x', 'metrics')"
        )
        conn.execute(
            "INSERT INTO job_runs (job_id, status, started_at, finished_at) "
            "VALUES ('usage.aggregate', 'succeeded', now() - interval '1 minute', now()) "
            "ON CONFLICT (job_id) DO UPDATE SET status = 'succeeded', finished_at = now()"
        )

    response = await client.get("/api/v1/system/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    body = response.text

    # schema 版本随 DDL 递增：断言关键版本在位即可，避免每次加 DDL 都要改测试
    assert 'huagent_build_info{schema_version="V0001' in body
    assert ",V0005" in body and ',version="0.1.0"} 1' in body
    assert 'huagent_db_gauge{metric="users_total"} 1' in body
    assert 'huagent_job_last_status{job_id="usage.aggregate",status="succeeded"} 1' in body
    assert 'huagent_job_last_timestamp_seconds{job_id="usage.aggregate",phase="finished"}' in body
    # 预算随任务表导出，与运行历史无关：告警规则据此判断「超出各自预算才算异常」
    assert 'huagent_job_staleness_budget_seconds{job_id="usage.aggregate"} 10800' in body
    assert 'huagent_job_staleness_budget_seconds{job_id="snapshot.cleanup"} 93600' in body
    # 本次采集请求本身不进入 HTTP 指标
    assert 'path="/api/v1/system/metrics"' not in body


async def test_metrics_path_label_uses_route_template(client: AsyncClient) -> None:
    missing = await client.get(
        "/api/v1/orgs/123e4567-e89b-12d3-a456-426614174000",
        headers={"authorization": "Bearer "},
    )
    assert missing.status_code == 401
    body = (await client.get("/api/v1/system/metrics")).text
    assert 'path="/api/v1/orgs/{org_id}"' in body
    assert "123e4567" not in body, "路径参数值不应作为标签"


async def test_metrics_requires_token(client: AsyncClient) -> None:
    unauthenticated = await client.get("/api/v1/system/metrics", headers={"authorization": "Bearer wrong"})
    assert unauthenticated.status_code == 401
