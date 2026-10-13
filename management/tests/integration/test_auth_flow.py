"""账号域集成测试（design 4.1 / 6.9.2）：真实 PG18 容器。

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

DDL_FILE = Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0001__init.sql"

DEVICE = {
    "deviceId": "device-0001",
    "platform": "win32",
    "appVersion": "0.1.0",
    "name": "测试机",
}


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    with PostgresContainer("postgres:18-alpine") as postgres:
        url = postgres.get_connection_url().replace(
            "postgresql+psycopg2://", "postgresql://"
        )
        with psycopg.connect(url) as conn:
            conn.execute(DDL_FILE.read_text(encoding="utf-8"))
        yield url


@pytest.fixture
async def client(database_url: str, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    if sys.platform == "win32":
        import asyncio
        import selectors

        asyncio.set_event_loop(asyncio.SelectorEventLoop(selectors.SelectSelector()))

    async_url = database_url.replace("postgresql://", "postgresql+psycopg://")
    monkeypatch.setenv("HUAGENT_DATABASE_URL", async_url)
    monkeypatch.setenv("HUAGENT_SCHEMA_CHECK_ENABLED", "false")
    monkeypatch.setenv("HUAGENT_RATE_LIMIT_STRICT", "false")

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


async def register(client: AsyncClient, email: str = "user@example.com") -> dict[str, object]:
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Str0ng-Passphrase-2026", "displayName": "测试用户"},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def login(client: AsyncClient, email: str = "user@example.com") -> dict[str, object]:
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "Str0ng-Passphrase-2026", "device": DEVICE},
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_register_login_and_profile(client: AsyncClient) -> None:
    created = await register(client)
    assert created["email"] == "user@example.com"
    assert "password" not in str(created)

    # 重复注册冲突
    duplicate = await client.post(
        "/api/v1/auth/register",
        json={"email": "user@example.com", "password": "Str0ng-Passphrase-2026", "displayName": "重名"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "CONFLICT"

    tokens = await login(client)
    assert tokens["tokenType"] == "Bearer"
    headers = {"Authorization": f"Bearer {tokens['accessToken']}"}

    me = await client.get("/api/v1/me", headers=headers)
    assert me.status_code == 200, me.text
    assert me.json()["displayName"] == "测试用户"

    patched = await client.patch("/api/v1/me", json={"displayName": "改名"}, headers=headers)
    assert patched.json()["displayName"] == "改名"

    devices = await client.get("/api/v1/me/devices", headers=headers)
    assert devices.status_code == 200
    body = devices.json()["devices"]
    assert len(body) == 1
    assert body[0]["deviceId"] == "device-0001"
    assert body[0]["current"] is True


async def test_login_wrong_password_and_missing_token(client: AsyncClient) -> None:
    await register(client, "wrong-pass@example.com")
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "wrong-pass@example.com", "password": "not-the-password", "device": DEVICE},
    )
    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHENTICATED"

    unauthorized = await client.get("/api/v1/me")
    assert unauthorized.status_code == 401
    assert unauthorized.json()["code"] == "UNAUTHENTICATED"


async def test_refresh_rotation_and_replay_detection(client: AsyncClient) -> None:
    await register(client, "rotate@example.com")
    tokens = await login(client, "rotate@example.com")
    old_refresh = str(tokens["refreshToken"])

    rotated = await client.post("/api/v1/auth/refresh", json={"refreshToken": old_refresh})
    assert rotated.status_code == 200, rotated.text
    new_refresh = rotated.json()["refreshToken"]
    assert new_refresh != old_refresh

    # 旧令牌重放：拒绝并撤销该设备全部会话
    replay = await client.post("/api/v1/auth/refresh", json={"refreshToken": old_refresh})
    assert replay.status_code == 401
    assert replay.json()["code"] == "REFRESH_REVOKED"

    after_replay = await client.post("/api/v1/auth/refresh", json={"refreshToken": new_refresh})
    assert after_replay.status_code == 401  # 同族令牌已被撤销

    # 重新登录可用；登出后刷新失效
    tokens2 = await login(client, "rotate@example.com")
    headers = {"Authorization": f"Bearer {tokens2['accessToken']}"}
    logout = await client.post("/api/v1/auth/logout", json={}, headers=headers)
    assert logout.status_code == 200
    assert logout.json()["revoked"] >= 1

    after_logout = await client.post(
        "/api/v1/auth/refresh", json={"refreshToken": tokens2["refreshToken"]}
    )
    assert after_logout.status_code == 401
    assert after_logout.json()["code"] == "REFRESH_REVOKED"


async def test_revoke_device_invalidates_refresh(client: AsyncClient) -> None:
    await register(client, "devices@example.com")
    tokens = await login(client, "devices@example.com")
    headers = {"Authorization": f"Bearer {tokens['accessToken']}"}

    revoked = await client.delete("/api/v1/me/devices/device-0001", headers=headers)
    assert revoked.status_code == 200
    assert revoked.json()["revokedTokens"] >= 1

    after = await client.post("/api/v1/auth/refresh", json={"refreshToken": tokens["refreshToken"]})
    assert after.status_code == 401

    missing = await client.delete("/api/v1/me/devices/not-exist", headers=headers)
    assert missing.status_code == 404


async def test_providers_endpoint(client: AsyncClient) -> None:
    response = await client.get("/api/v1/auth/providers")
    assert response.status_code == 200
    ids = [item["id"] for item in response.json()["providers"]]
    assert "local" in ids
