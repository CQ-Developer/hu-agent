"""用量上传集成测试（design 6.7.1）：幂等、归属校验、时间窗校验。"""

from __future__ import annotations

import os
import sys
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
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

DDL_FILE = Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0001__init.sql"

DEVICE = {"deviceId": "device-usage", "platform": "win32", "appVersion": "0.1.0"}


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    with PostgresContainer("postgres:18-alpine") as postgres:
        url = postgres.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url) as conn:
            conn.execute(DDL_FILE.read_text(encoding="utf-8"))
        yield url


@pytest.fixture
async def client(database_url: str, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    if sys.platform == "win32":
        import asyncio
        import selectors

        asyncio.set_event_loop(asyncio.SelectorEventLoop(selectors.SelectSelector()))

    monkeypatch.setenv("HUAGENT_DATABASE_URL", database_url.replace("postgresql://", "postgresql+psycopg://"))
    monkeypatch.setenv("HUAGENT_SCHEMA_CHECK_ENABLED", "false")

    from huagent.common.config import get_settings
    from huagent.common.ratelimit import reset_login_guard
    from huagent.domain.db import dispose_engine

    get_settings.cache_clear()
    reset_login_guard()
    await dispose_engine()

    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http

    await dispose_engine()


def event(event_id: uuid.UUID | None = None, **overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "eventId": str(event_id or uuid.uuid7()),
        "occurredAt": datetime.now(UTC).isoformat(),
        "deviceId": "device-usage",
        "appVersion": "0.1.0",
        "purpose": "primary",
        "provider": "deepseek",
        "model": "deepseek-chat",
        "inputTokens": 1200,
        "outputTokens": 350,
        "cacheReadTokens": 0,
        "requests": 1,
        "durationMs": 3120,
        "status": "success",
    }
    payload.update(overrides)
    return payload


async def setup_user(client: AsyncClient, email: str) -> dict[str, str]:
    await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Str0ng-Passphrase-2026", "displayName": "用量用户"},
    )
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "Str0ng-Passphrase-2026", "device": DEVICE},
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


async def test_batch_accept_duplicate_and_isolation(client: AsyncClient) -> None:
    headers = await setup_user(client, "usage@example.com")
    first = str(uuid.uuid7())

    response = await client.post(
        "/api/v1/usage:batch",
        json={"events": [event(first), event()]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["received"] == 2
    assert body["accepted"] == 2
    assert body["duplicated"] == 0
    assert body["rejected"] == 0

    # 幂等：同批重发只计 duplicated（occurredAt 毫秒差异也不应重复入库）
    again = await client.post(
        "/api/v1/usage:batch", json={"events": [event(first)]}, headers=headers
    )
    assert again.json() == {
        "received": 1,
        "accepted": 0,
        "duplicated": 1,
        "rejected": 0,
        "sanitized": 0,
    }

    # 同批内重复 event_id：只收第一条
    one = event()
    inside = await client.post(
        "/api/v1/usage:batch",
        json={"events": [one, one]},
        headers=headers,
    )
    body_inside = inside.json()
    assert body_inside["accepted"] == 1
    assert body_inside["duplicated"] == 1

    # 其他用户不能用自己的 token 伪造归属（unknown team/workspace 置空并计数）
    unknown = await client.post(
        "/api/v1/usage:batch",
        json={
            "events": [
                event(teamId=str(uuid.uuid7()), workspaceId=str(uuid.uuid7())),
            ]
        },
        headers=headers,
    )
    body = unknown.json()
    assert body["accepted"] == 1
    assert body["sanitized"] == 2


async def test_out_of_window_events_are_rejected(client: AsyncClient) -> None:
    headers = await setup_user(client, "window@example.com")
    too_old = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    response = await client.post(
        "/api/v1/usage:batch",
        json={"events": [event(occurredAt=too_old), event()]},
        headers=headers,
    )
    body = response.json()
    assert body["rejected"] == 1
    assert body["accepted"] == 1


async def test_batch_requires_auth_and_limits_size(client: AsyncClient) -> None:
    anonymous = await client.post("/api/v1/usage:batch", json={"events": [event()]})
    assert anonymous.status_code == 401

    headers = await setup_user(client, "limit@example.com")
    too_many = await client.post(
        "/api/v1/usage:batch",
        json={"events": [event() for _ in range(101)]},
        headers=headers,
    )
    assert too_many.status_code == 422
    assert too_many.json()["code"] == "VALIDATION_FAILED"
