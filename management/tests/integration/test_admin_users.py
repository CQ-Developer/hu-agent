"""集成测试：系统区用户管理（design 7.2 / 6.10.1）——列表、禁用/启用、强制下线、
注销宽限期恢复、一次性重置令牌、邀请撤销。

默认跳过（需要 Docker）；运行：
    HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
"""

from __future__ import annotations

import os
import sys
import uuid
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
PASSWORD = "Admin-Users-Passphrase-2026"
NEW_PASSWORD = "Admin-Users-New-Passphrase-2026"
DEVICE = {"deviceId": "admin-users", "platform": "win32", "appVersion": "0.1.0"}


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


def user_id_of(pg_url: str, email: str) -> str:
    return str(sql(pg_url, "SELECT id FROM users WHERE email = %s", (email,))[0][0])


def seed_org(pg_url: str, owner_id: str, name: str) -> str:
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


def seed_org_member(pg_url: str, org_id: str, user_id: str, role: str = "member") -> None:
    sql(
        pg_url,
        "INSERT INTO org_members (org_id, user_id, role, status) VALUES (%s, %s, %s, 'active')",
        (org_id, user_id, role),
    )


def seed_team(pg_url: str, org_id: str, owner_id: str, name: str) -> str:
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
    return team_id


async def login(
    client: AsyncClient,
    email: str,
    *,
    password: str = PASSWORD,
    system_admin: bool = False,
    pg_url: str | None = None,
) -> dict[str, str]:
    created = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": password, "displayName": "用户管理测试"}
    )
    assert created.status_code in (201, 409), created.text
    logged = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": password, "device": DEVICE}
    )
    assert logged.status_code == 200, logged.text
    if system_admin:
        assert pg_url is not None
        sql(pg_url, "UPDATE users SET is_system_admin = true WHERE email = %s", (email,))
    return {"authorization": f"Bearer {logged.json()['accessToken']}"}


async def login_raw(client: AsyncClient, email: str, password: str) -> tuple[int, dict[str, object]]:
    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": password, "device": DEVICE}
    )
    return response.status_code, response.json()


def unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}@example.com"


@pytest.fixture
def pg_url(database_url: str) -> str:
    return database_url.replace("postgresql+psycopg://", "postgresql://")


async def test_list_search_and_permissions(client: AsyncClient, pg_url: str) -> None:
    admin_email, target_email = unique("sysadmin"), unique("target")
    admin = await login(client, admin_email, system_admin=True, pg_url=pg_url)
    member = await login(client, unique("member"))

    forbidden = await client.get("/api/v1/admin/users", headers=member)
    assert forbidden.status_code == 403, forbidden.text

    await login(client, target_email)
    listed = await client.get("/api/v1/admin/users", params={"q": target_email}, headers=admin)
    assert listed.status_code == 200, listed.text
    body = listed.json()
    assert body["total"] == 1 and len(body["items"]) == 1
    item = body["items"][0]
    assert item["email"] == target_email
    assert item["status"] == "active"
    assert item["hasPassword"] is True
    assert item["deletionRequestedAt"] is None and item["purgeAt"] is None

    # 状态筛选互斥：活跃账号不出现在「注销宽限期」里
    pending = await client.get(
        "/api/v1/admin/users", params={"q": target_email, "status": "pending_deletion"}, headers=admin
    )
    assert pending.json()["total"] == 0
    disabled = await client.get(
        "/api/v1/admin/users", params={"q": target_email, "status": "active"}, headers=admin
    )
    assert disabled.json()["total"] == 1


async def test_disable_enable_and_force_logout(client: AsyncClient, pg_url: str) -> None:
    admin_email, target_email = unique("sysadmin"), unique("target")
    admin = await login(client, admin_email, system_admin=True, pg_url=pg_url)
    await login(client, target_email)
    target_id = user_id_of(pg_url, target_email)

    self_disable = await client.post(
        f"/api/v1/admin/users/{user_id_of(pg_url, admin_email)}:disable", json={}, headers=admin
    )
    assert self_disable.status_code == 422, self_disable.text

    disabled = await client.post(
        f"/api/v1/admin/users/{target_id}:disable", json={"reason": "安全事件排查"}, headers=admin
    )
    assert disabled.status_code == 200, disabled.text
    status_code, _ = await login_raw(client, target_email, PASSWORD)
    assert status_code == 403  # ACCOUNT_DISABLED

    notes = sql(
        pg_url,
        "SELECT count(*) FROM notifications WHERE user_id = %s AND type = 'user.disabled'",
        (target_id,),
    )[0][0]
    assert notes == 1
    audits = sql(
        pg_url, "SELECT count(*) FROM audit_logs WHERE action = 'admin.user.disable' AND target_id = %s", (target_id,)
    )[0][0]
    assert audits == 1
    # 幂等：重复禁用不再新增通知/审计
    again = await client.post(f"/api/v1/admin/users/{target_id}:disable", json={}, headers=admin)
    assert again.status_code == 200
    assert sql(pg_url, "SELECT count(*) FROM audit_logs WHERE action = 'admin.user.disable'")[0][0] == audits

    enabled = await client.post(f"/api/v1/admin/users/{target_id}:enable", headers=admin)
    assert enabled.status_code == 200, enabled.text
    status_code, _ = await login_raw(client, target_email, PASSWORD)
    assert status_code == 200

    # 强制下线：撤销该账号全部刷新令牌
    await login(client, target_email)
    active_tokens = sql(
        pg_url, "SELECT count(*) FROM refresh_tokens WHERE user_id = %s AND revoked_at IS NULL", (target_id,)
    )[0][0]
    assert active_tokens > 0
    forced = await client.post(f"/api/v1/admin/users/{target_id}:force-logout", headers=admin)
    assert forced.status_code == 200, forced.text
    assert forced.json()["revoked"] >= 1
    now_active = sql(
        pg_url, "SELECT count(*) FROM refresh_tokens WHERE user_id = %s AND revoked_at IS NULL", (target_id,)
    )[0][0]
    assert now_active == 0


async def test_reset_password_token_lifecycle(client: AsyncClient, pg_url: str) -> None:
    admin_email, target_email = unique("sysadmin"), unique("target")
    admin = await login(client, admin_email, system_admin=True, pg_url=pg_url)
    await login(client, target_email)
    target_id = user_id_of(pg_url, target_email)
    stale_refresh = (
        await client.post(
            "/api/v1/auth/login", json={"email": target_email, "password": PASSWORD, "device": DEVICE}
        )
    ).json()["refreshToken"]

    issued = await client.post(f"/api/v1/admin/users/{target_id}:reset-password", headers=admin)
    assert issued.status_code == 200, issued.text
    token = issued.json()["token"]
    assert token and issued.json()["expiresAt"]

    # 签发本身不改密码、不撤销会话
    status_code, _ = await login_raw(client, target_email, PASSWORD)
    assert status_code == 200

    unknown = await client.post("/api/v1/auth/password/reset", json={"token": "not-a-token", "password": NEW_PASSWORD})
    assert unknown.status_code == 404, unknown.text
    weak = await client.post("/api/v1/auth/password/reset", json={"token": token, "password": "short"})
    assert weak.status_code == 422, weak.text

    reset = await client.post("/api/v1/auth/password/reset", json={"token": token, "password": NEW_PASSWORD})
    assert reset.status_code == 200, reset.text
    status_code, _ = await login_raw(client, target_email, PASSWORD)
    assert status_code == 401
    status_code, _ = await login_raw(client, target_email, NEW_PASSWORD)
    assert status_code == 200

    # 重置撤销此前全部会话；令牌一次性
    replay_refresh = await client.post("/api/v1/auth/refresh", json={"refreshToken": stale_refresh})
    assert replay_refresh.status_code in (401, 403), replay_refresh.text
    replay = await client.post("/api/v1/auth/password/reset", json={"token": token, "password": NEW_PASSWORD})
    assert replay.status_code == 409, replay.text
    assert sql(pg_url, "SELECT count(*) FROM audit_logs WHERE action = 'auth.password.reset'")[0][0] >= 1

    # 重新签发时旧令牌作废
    first = await client.post(f"/api/v1/admin/users/{target_id}:reset-password", headers=admin)
    second = await client.post(f"/api/v1/admin/users/{target_id}:reset-password", headers=admin)
    assert second.status_code == 200
    superseded = await client.post(
        "/api/v1/auth/password/reset", json={"token": first.json()["token"], "password": PASSWORD}
    )
    assert superseded.status_code == 404
    accepted = await client.post(
        "/api/v1/auth/password/reset", json={"token": second.json()["token"], "password": PASSWORD}
    )
    assert accepted.status_code == 200, accepted.text


async def test_pending_deletion_and_restore(client: AsyncClient, pg_url: str) -> None:
    admin_email, target_email = unique("sysadmin"), unique("target")
    admin = await login(client, admin_email, system_admin=True, pg_url=pg_url)
    target = await login(client, target_email)
    target_id = user_id_of(pg_url, target_email)

    deleted = await client.post(
        "/api/v1/me:delete", json={"confirmEmail": target_email, "password": PASSWORD}, headers=target
    )
    assert deleted.status_code == 200, deleted.text

    pending = await client.get(
        "/api/v1/admin/users", params={"q": target_email, "status": "pending_deletion"}, headers=admin
    )
    assert pending.status_code == 200, pending.text
    item = pending.json()["items"][0]
    assert item["deletionRequestedAt"] is not None
    assert item["purgeAt"] is not None and item["purgeAt"] > item["deletionRequestedAt"]

    # 宽限期内不能用 enable 清掉注销意图，必须走 restore
    rejected = await client.post(f"/api/v1/admin/users/{target_id}:enable", headers=admin)
    assert rejected.status_code == 422, rejected.text
    restored = await client.post(f"/api/v1/admin/users/{target_id}:restore", headers=admin)
    assert restored.status_code == 200, restored.text
    status_code, _ = await login_raw(client, target_email, PASSWORD)
    assert status_code == 200
    restored_notes = sql(
        pg_url,
        "SELECT count(*) FROM notifications WHERE user_id = %s AND type = 'user.restored'",
        (target_id,),
    )[0][0]
    assert restored_notes == 1
    # 不在宽限期的账号 restore 报错
    again = await client.post(f"/api/v1/admin/users/{target_id}:restore", headers=admin)
    assert again.status_code == 422, again.text


async def test_invitation_list_and_revoke(client: AsyncClient, pg_url: str) -> None:
    admin_email, owner_email = unique("sysadmin"), unique("orgadmin")
    member_email = unique("invitee")
    admin = await login(client, admin_email, system_admin=True, pg_url=pg_url)
    owner = await login(client, owner_email)
    member = await login(client, member_email)
    org_id = seed_org(pg_url, user_id_of(pg_url, owner_email), f"org-{uuid.uuid4().hex[:6]}")
    member_id = user_id_of(pg_url, member_email)

    invited = await client.post(
        f"/api/v1/orgs/{org_id}/invitations", json={"email": member_email, "role": "member"}, headers=owner
    )
    assert invited.status_code == 201, invited.text
    token = invited.json()["acceptToken"]

    listed = await client.get(f"/api/v1/orgs/{org_id}/invitations", headers=owner)
    assert listed.status_code == 200, listed.text
    assert [item["email"] for item in listed.json()] == [member_email]
    assert listed.json()[0]["invitedByEmail"] == owner_email

    # 非组织管理员不可见、不可撤销
    assert (await client.get(f"/api/v1/orgs/{org_id}/invitations", headers=admin)).status_code == 200
    non_admin = await login(client, unique("outsider"))
    assert (await client.get(f"/api/v1/orgs/{org_id}/invitations", headers=non_admin)).status_code == 404

    revoked = await client.post(
        "/api/v1/invitations:revoke", json={"invitationId": listed.json()[0]["id"]}, headers=owner
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["status"] == "revoked"
    assert (await client.get(f"/api/v1/orgs/{org_id}/invitations", headers=owner)).json() == []
    accepted = await client.post("/api/v1/invitations:accept", json={"token": token}, headers=member)
    assert accepted.status_code == 409, accepted.text
    # 重复撤销：已失效
    assert (
        await client.post("/api/v1/invitations:revoke", json={"invitationId": listed.json()[0]["id"]}, headers=owner)
    ).status_code == 409

    # 团队邀请：组织成员才能被邀请；列表与撤销同样仅团队管理员可用
    seed_org_member(pg_url, org_id, member_id)
    team_id = seed_team(pg_url, org_id, user_id_of(pg_url, owner_email), f"team-{uuid.uuid4().hex[:6]}")
    team_invite = await client.post(
        f"/api/v1/teams/{team_id}/invitations", json={"email": member_email, "role": "member"}, headers=owner
    )
    assert team_invite.status_code == 201, team_invite.text
    team_pending = await client.get(f"/api/v1/teams/{team_id}/invitations", headers=owner)
    assert team_pending.status_code == 200, team_pending.text
    assert len(team_pending.json()) == 1
    assert (
        await client.post(
            "/api/v1/invitations:revoke", json={"invitationId": team_pending.json()[0]["id"]}, headers=owner
        )
    ).status_code == 200
    assert (await client.get(f"/api/v1/teams/{team_id}/invitations", headers=owner)).json() == []
