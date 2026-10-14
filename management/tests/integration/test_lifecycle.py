"""集成测试：用户数据生命周期（design 6.10.5）——导出、注销、宽限期后清理。

默认跳过（需要 Docker）；运行：
    HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
"""

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

DDL_DIR = Path(__file__).resolve().parents[3] / "db" / "ddl"
DEVICE = {"deviceId": "lifecycle-device", "platform": "win32", "appVersion": "0.1.0"}


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
    monkeypatch.setenv("HUAGENT_OBJECT_STORE", "memory")
    monkeypatch.setenv("HUAGENT_LOGIN_IP_LIMIT", "1000")
    monkeypatch.setenv("HUAGENT_LOGIN_FAIL_THRESHOLD", "1000")

    from huagent.common.config import get_settings
    from huagent.common.ratelimit import reset_login_guard
    from huagent.domain.db import dispose_engine

    get_settings.cache_clear()
    reset_login_guard()
    app = create_app()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http_client:
        yield http_client
    await dispose_engine()
    get_settings.cache_clear()


def sql(url: str, statement: str, params: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    with psycopg.connect(url) as conn:
        cursor = conn.execute(statement, params)
        if cursor.description:
            return list(cursor.fetchall())
    return []


async def register(client: AsyncClient, email: str, password: str = "Lifecycle-Passphrase-2026") -> dict[str, str]:
    created = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": password, "displayName": "生命周期"}
    )
    assert created.status_code in (201, 409), created.text
    logged = await client.post("/api/v1/auth/login", json={"email": email, "password": password, "device": DEVICE})
    assert logged.status_code == 200, logged.text
    return {"authorization": f"Bearer {logged.json()['accessToken']}"}


async def test_export_contains_personal_sections(client: AsyncClient, database_url: str) -> None:
    headers = await register(client, f"export-{uuid.uuid4().hex[:6]}@example.com")
    report = await client.post(
        "/api/v1/me/activations:report",
        json={
            "deviceId": DEVICE["deviceId"],
            "scope": "global",
            "items": [{"type": "skill", "source": "local", "name": "demo", "version": "1.0.0", "enabled": True}],
        },
        headers=headers,
    )
    assert report.status_code == 200, report.text

    exported = await client.get("/api/v1/me/export", headers=headers)
    assert exported.status_code == 200, exported.text
    body = exported.json()
    sections = (
        "profile",
        "memberships",
        "devices",
        "identities",
        "notifications",
        "activations",
        "usageDaily",
        "audit",
    )
    for section in sections:
        assert section in body, f"导出缺少 {section}"
    assert body["profile"]["email"].startswith("export-")
    assert body["devices"][0]["deviceId"] == "lifecycle-device"
    assert body["retention"]["usageDailyDays"] == 730
    # 导出动作本身写入审计，且返回给本人
    assert any(item["action"] == "account.export" for item in body["audit"]) or sql(
        database_url, "SELECT count(*) FROM audit_logs WHERE action = 'account.export'"
    )[0][0] >= 1


async def test_delete_request_blocks_login_and_purge_removes_pii(
    client: AsyncClient, database_url: str
) -> None:
    email = f"delete-{uuid.uuid4().hex[:6]}@example.com"
    headers = await register(client, email)
    await client.post(
        "/api/v1/usage:batch",
        json={
            "events": [
                {
                    "eventId": str(uuid.uuid4()),
                    "occurredAt": datetime.now(UTC).isoformat(),
                    "deviceId": DEVICE["deviceId"],
                    "provider": "deepseek",
                    "model": "lifecycle-model",
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "requests": 1,
                    "status": "success",
                }
            ]
        },
        headers=headers,
    )

    # 1) 确认邮箱不匹配 / 密码错误 → 拒绝
    credentials = {"password": "Lifecycle-Passphrase-2026"}
    wrong_email = await client.post(
        "/api/v1/me:delete", json={"confirmEmail": "someone@example.com", **credentials}, headers=headers
    )
    assert wrong_email.status_code == 422, wrong_email.text
    wrong_password = await client.post(
        "/api/v1/me:delete", json={"confirmEmail": email, "password": "wrong-password"}, headers=headers
    )
    assert wrong_password.status_code == 401, wrong_password.text

    # 2) 正常注销：立即停用 + 撤销全部会话
    deleted = await client.post(
        "/api/v1/me:delete", json={"confirmEmail": email, **credentials, "reason": "不再使用"}, headers=headers
    )
    assert deleted.status_code == 200, deleted.text
    assert deleted.json()["status"] == "disabled"
    assert deleted.json()["graceDays"] == 30
    user_id = sql(database_url, "SELECT id FROM users WHERE email = %s", (email,))[0][0]
    active_tokens = sql(
        database_url, "SELECT count(*) FROM refresh_tokens WHERE user_id = %s AND revoked_at IS NULL", (user_id,)
    )[0][0]
    assert active_tokens == 0
    # 注销后无法再登录（账号已停用）
    blocked = await client.post(
        "/api/v1/auth/login", json={"email": email, **credentials, "device": DEVICE}
    )
    assert blocked.status_code in (401, 403), blocked.text

    # 3) 未到宽限期：不清理
    from huagent.domain.db import get_session_factory
    from huagent.worker.jobs import purge_deleted_users

    session_factory = get_session_factory()
    async with session_factory() as session:
        assert await purge_deleted_users(session) == 0
    assert sql(database_url, "SELECT purged_at IS NULL FROM users WHERE id = %s", (user_id,))[0][0] is True

    # 4) 宽限期已过：清理 PII 与个人数据，用量改挂匿名占位
    past = datetime.now(UTC) - timedelta(days=40)
    sql(database_url, "UPDATE users SET deletion_requested_at = %s WHERE id = %s", (past, user_id))
    async with session_factory() as session:
        assert await purge_deleted_users(session) == 1

    anonymized_email, display_name, purged = sql(
        database_url, "SELECT email, display_name, purged_at IS NOT NULL FROM users WHERE id = %s", (user_id,)
    )[0]
    assert str(anonymized_email).startswith("deleted-") and "deleted.invalid" in str(anonymized_email)
    assert display_name == "已注销用户"
    assert purged is True
    assert sql(database_url, "SELECT count(*) FROM devices WHERE user_id = %s", (user_id,))[0][0] == 0
    assert sql(database_url, "SELECT count(*) FROM notifications WHERE user_id = %s", (user_id,))[0][0] == 0
    assert sql(database_url, "SELECT count(*) FROM activation_reports WHERE user_id = %s", (user_id,))[0][0] == 0
    # 审计保留（合规），且记录了注销动作
    delete_audits = sql(
        database_url,
        "SELECT count(*) FROM audit_logs WHERE actor_id = %s AND action = 'account.delete_requested'",
        (user_id,),
    )[0][0]
    assert delete_audits >= 1
    # 用量不再关联个人
    assert sql(database_url, "SELECT count(*) FROM usage_events WHERE user_id = %s", (user_id,))[0][0] == 0
    assert sql(
        database_url, "SELECT count(*) FROM usage_events WHERE user_id = '00000000-0000-0000-0000-000000000000'"
    )[0][0] >= 1

    # 5) 幂等：再跑一次不再处理
    async with session_factory() as session:
        assert await purge_deleted_users(session) == 0
