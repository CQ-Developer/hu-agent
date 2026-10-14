"""集成测试：运维管理接口（design 7.2 系统区）——审计、系统设置、价格表、组织/团队治理。

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
PASSWORD = "Admin-Ops-Passphrase-2026"
DEVICE = {"deviceId": "admin-ops", "platform": "win32", "appVersion": "0.1.0"}


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


def latest_user_id(pg_url: str, prefix: str) -> object:
    """取最近注册的某前缀账号 id（测试内造数据用）。"""
    return sql(
        pg_url,
        "SELECT id FROM users WHERE email LIKE %s ORDER BY created_at DESC LIMIT 1",
        (f"{prefix}-%",),
    )[0][0]


def seed_org(pg_url: str, owner_id: object, name: str) -> str:
    org_id = str(uuid.uuid4())
    sql(
        pg_url,
        "INSERT INTO orgs (id, name, slug, description, status) VALUES (%s, %s, %s, '', 'active')",
        (org_id, name, f"seed-{uuid.uuid4().hex[:8]}"),
    )
    sql(
        pg_url,
        "INSERT INTO org_members (org_id, user_id, role, status) VALUES (%s, %s, 'admin', 'active')",
        (org_id, owner_id),
    )
    return org_id


def seed_team(pg_url: str, org_id: str, owner_id: object, name: str, member_id: object | None = None) -> str:
    team_id = str(uuid.uuid4())
    sql(
        pg_url,
        "INSERT INTO teams (id, org_id, name, description, status) VALUES (%s, %s, %s, '', 'active')",
        (team_id, org_id, name),
    )
    sql(
        pg_url,
        "INSERT INTO team_members (team_id, user_id, role, status) VALUES (%s, %s, 'admin', 'active')",
        (team_id, owner_id),
    )
    if member_id is not None:
        sql(
            pg_url,
            "INSERT INTO team_members (team_id, user_id, role, status) VALUES (%s, %s, 'member', 'active')",
            (team_id, member_id),
        )
    return team_id


async def login(client: AsyncClient, email: str, *, system_admin: bool = False) -> dict[str, str]:
    created = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": PASSWORD, "displayName": "运维测试"}
    )
    assert created.status_code in (201, 409), created.text
    logged = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD, "device": DEVICE})
    assert logged.status_code == 200, logged.text
    if system_admin:
        # 测试内直接赋权（真实环境由运维授予）
        with psycopg.connect(os.environ["HUAGENT_TESTCONTAINERS_URL"]) as conn:
            conn.execute("UPDATE users SET is_system_admin = true WHERE email = %s", (email,))
    return {"authorization": f"Bearer {logged.json()['accessToken']}"}


@pytest.fixture
def pg_url(database_url: str, monkeypatch: pytest.MonkeyPatch) -> str:
    sync_url = database_url.replace("postgresql+psycopg://", "postgresql://")
    monkeypatch.setenv("HUAGENT_TESTCONTAINERS_URL", sync_url)
    return sync_url


async def test_admin_settings_whitelist_and_audit(client: AsyncClient, pg_url: str) -> None:
    admin_email = f"sysadmin-{uuid.uuid4().hex[:6]}@example.com"
    admin = await login(client, admin_email, system_admin=True)
    member = await login(client, f"member-{uuid.uuid4().hex[:6]}@example.com")

    # 非系统管理员：403
    forbidden = await client.get("/api/v1/admin/settings", headers=member)
    assert forbidden.status_code == 403

    listed = await client.get("/api/v1/admin/settings", headers=admin)
    assert listed.status_code == 200, listed.text
    keys = {item["key"] for item in listed.json()["items"]}
    assert {"quota.user_bytes", "usage.daily_retention_days", "min_client_version"} <= keys
    assert "usage.daily_retention_days" in keys

    # 白名单外的键拒绝
    rejected = await client.patch(
        "/api/v1/admin/settings", json={"values": {"totally.unknown": 1}}, headers=admin
    )
    assert rejected.status_code == 422, rejected.text

    # 低于下限拒绝
    too_small = await client.patch(
        "/api/v1/admin/settings", json={"values": {"usage.retention_days": 1}}, headers=admin
    )
    assert too_small.status_code == 422, too_small.text

    # 正常写入 + 审计
    updated = await client.patch(
        "/api/v1/admin/settings",
        json={"values": {"usage.retention_days": 120, "min_client_version": "0.2.0"}},
        headers=admin,
    )
    assert updated.status_code == 200, updated.text
    values = {item["key"]: item["value"] for item in updated.json()["items"]}
    assert values["usage.retention_days"] == 120
    assert values["min_client_version"] == "0.2.0"
    settings_audits = sql(pg_url, "SELECT count(*) FROM audit_logs WHERE action = 'admin.settings.update'")[0][0]
    assert settings_audits >= 1


async def test_admin_audit_filters(client: AsyncClient, pg_url: str) -> None:
    admin_email = f"sysadmin-{uuid.uuid4().hex[:6]}@example.com"
    admin = await login(client, admin_email, system_admin=True)
    await client.patch("/api/v1/admin/settings", json={"values": {"quota.user_bytes": 123456}}, headers=admin)

    listed = await client.get("/api/v1/admin/audit", params={"action": "admin.", "limit": 10}, headers=admin)
    assert listed.status_code == 200, listed.text
    items = listed.json()["items"]
    assert items and all(item["action"].startswith("admin.") for item in items)
    assert any(item["action"] == "admin.settings.update" for item in items)

    # 时间过滤：未来时间窗内应有记录，过去时间窗内应为空
    future = (datetime.now(UTC) + timedelta(minutes=1)).isoformat()
    empty = await client.get(
        "/api/v1/admin/audit", params={"date_from": future, "action": "admin."}, headers=admin
    )
    assert empty.json()["items"] == []


async def test_admin_prices_upsert_list_delete(client: AsyncClient, pg_url: str) -> None:
    admin_email = f"sysadmin-{uuid.uuid4().hex[:6]}@example.com"
    admin = await login(client, admin_email, system_admin=True)
    model = f"pricing-{uuid.uuid4().hex[:6]}"

    created = await client.post(
        "/api/v1/admin/prices",
        json={
            "provider": "deepseek",
            "model": model,
            "currency": "USD",
            "inputPrice": 0.14,
            "outputPrice": 0.28,
            "effectiveFrom": "2026-01-01",
        },
        headers=admin,
    )
    assert created.status_code == 200, created.text

    listed = await client.get("/api/v1/admin/prices", params={"model": model}, headers=admin)
    assert listed.status_code == 200, listed.text
    assert len(listed.json()) == 1
    assert listed.json()[0]["inputPrice"] == pytest.approx(0.14)

    # 负价拒绝
    negative = await client.post(
        "/api/v1/admin/prices",
        json={"provider": "deepseek", "model": model, "inputPrice": -1, "effectiveFrom": "2026-01-01"},
        headers=admin,
    )
    assert negative.status_code == 422

    removed = await client.delete(
        "/api/v1/admin/prices",
        params={"provider": "deepseek", "model": model, "effective_from": "2026-01-01"},
        headers=admin,
    )
    assert removed.status_code == 200 and removed.json()["deleted"] == 1
    audits = sql(
        pg_url,
        "SELECT count(*) FROM audit_logs WHERE action IN ('admin.price.upsert', 'admin.price.delete')",
    )[0][0]
    assert audits >= 2


async def test_org_freeze_and_dissolve_make_resources_read_only(client: AsyncClient, pg_url: str) -> None:
    admin = await login(client, f"sysadmin-{uuid.uuid4().hex[:6]}@example.com", system_admin=True)
    owner = await login(client, f"owner-{uuid.uuid4().hex[:6]}@example.com")

    # 组织 + 团队（直接建库造数据，避免审批链路耦合）
    owner_id = latest_user_id(pg_url, "owner")
    org_id = seed_org(pg_url, owner_id, "冻结测试组织")
    team_id = seed_team(pg_url, org_id, owner_id, "冻结测试团队")

    # 1) 非系统管理员不能冻结
    denied = await client.post(f"/api/v1/admin/orgs/{org_id}:freeze", headers=owner)
    assert denied.status_code == 403

    # 2) 冻结 → 组织内资源只读（组织成员可见但 status=frozen）
    frozen = await client.post(f"/api/v1/admin/orgs/{org_id}:freeze", headers=admin)
    assert frozen.status_code == 200, frozen.text
    assert frozen.json()["status"] == "frozen"
    orgs = await client.get("/api/v1/orgs", headers=owner)
    assert next(item for item in orgs.json() if item["id"] == org_id)["status"] == "frozen"

    # 3) 解冻
    unfrozen = await client.post(f"/api/v1/admin/orgs/{org_id}:unfreeze", headers=admin)
    assert unfrozen.json()["status"] == "active"

    # 4) 解散：组织 deleted、团队 archived
    dissolved = await client.post(f"/api/v1/admin/orgs/{org_id}:dissolve", headers=admin)
    assert dissolved.status_code == 200, dissolved.text
    assert dissolved.json()["status"] == "deleted"
    assert sql(pg_url, "SELECT status FROM teams WHERE id = %s", (team_id,))[0][0] == "archived"
    # 解散后组织不再对成员可见（不可见 → 404 语义）
    after = await client.get("/api/v1/orgs", headers=owner)
    assert all(item["id"] != org_id for item in after.json())
    assert sql(pg_url, "SELECT count(*) FROM audit_logs WHERE action = 'admin.org.dissolve'")[0][0] >= 1


async def test_team_update_and_archive_requires_org_admin(client: AsyncClient, pg_url: str) -> None:
    owner = await login(client, f"owner-{uuid.uuid4().hex[:6]}@example.com")
    member = await login(client, f"member-{uuid.uuid4().hex[:6]}@example.com")

    owner_id = latest_user_id(pg_url, "owner")
    member_id = latest_user_id(pg_url, "member")
    org_id = seed_org(pg_url, owner_id, "团队治理组织")
    sql(
        pg_url,
        "INSERT INTO org_members (org_id, user_id, role, status) VALUES (%s, %s, 'member', 'active')",
        (org_id, member_id),
    )
    team_id = seed_team(pg_url, org_id, owner_id, "治理团队", member_id)

    # 普通成员不能改名
    denied = await client.patch(f"/api/v1/teams/{team_id}", json={"name": "改名"}, headers=member)
    assert denied.status_code == 403

    renamed = await client.patch(f"/api/v1/teams/{team_id}", json={"name": "治理团队（已改名）"}, headers=owner)
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "治理团队（已改名）"

    # 团队管理员（同时也是组织管理员）可冻结
    archived = await client.patch(f"/api/v1/teams/{team_id}", json={"status": "archived"}, headers=owner)
    assert archived.status_code == 200, archived.text
    assert archived.json()["status"] == "archived"
    assert sql(pg_url, "SELECT count(*) FROM audit_logs WHERE action IN ('team.update','team.status')")[0][0] >= 2

    restored = await client.patch(f"/api/v1/teams/{team_id}", json={"status": "active"}, headers=owner)
    assert restored.json()["status"] == "active"
