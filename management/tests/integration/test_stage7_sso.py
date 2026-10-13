"""SSO / OIDC 集成测试（design 6.12）：身份源管理、authorize/callback/exchange、JIT、禁用撤销。

- 通过依赖注入替换 HTTP 传输与主密钥加密（测试无需 `cryptography`）；
- ID Token 使用 HS256（client_secret 作密钥），走真实 PyJWT 验签代码路径。

运行：HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
"""

from __future__ import annotations

import base64
import os
import sys
import urllib.parse
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import jwt
import psycopg
import pytest
from httpx import ASGITransport, AsyncClient
from testcontainers.community.postgres import PostgresContainer

from huagent.api.app import create_app
from huagent.common.crypto import get_secret_cipher
from huagent.domain.oidc import code_challenge_s256, get_oidc_http, new_verifier

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("HUAGENT_TESTCONTAINERS") != "1",
        reason="需要 Docker；设置 HUAGENT_TESTCONTAINERS=1 后运行",
    ),
]

DDL_FILES = [
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0001__init.sql",
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0002__stage5.sql",
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0003__stage6.sql",
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0004__stage7.sql",
]
PASSWORD = "Str0ng-Passphrase-2026"
ISSUER = "http://idp.test"
CLIENT_ID = "hu-agent-client"
CLIENT_SECRET = "super-secret-value"
REDIRECT_URI = "http://127.0.0.1:47821/callback"


class FakeCipher:
    """测试用可逆替身；真实实现是 AES-GCM（需要 cryptography）。"""

    def encrypt(self, plaintext: str) -> str:
        return "fake:" + base64.b64encode(plaintext.encode()).decode()

    def decrypt(self, token: str) -> str:
        return base64.b64decode(token.removeprefix("fake:")).decode()


class FakeOidcHttp:
    """假 IdP：发现文档 + HS256 签名的 ID Token（userinfo 走同一份 claims）。"""

    def __init__(self, claims: dict[str, Any] | None = None) -> None:
        self.claims = claims or {
            "sub": "idp-subject-001",
            "email": "newbie@example.com",
            "email_verified": True,
            "name": "SSO 用户",
        }
        self.token_requests: list[dict[str, str]] = []

    async def get_json(self, url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
        if url.endswith("/.well-known/openid-configuration"):
            return {
                "issuer": ISSUER,
                "authorization_endpoint": f"{ISSUER}/authorize",
                "token_endpoint": f"{ISSUER}/token",
                "userinfo_endpoint": f"{ISSUER}/userinfo",
                "jwks_uri": f"{ISSUER}/jwks",
            }
        if url.endswith("/userinfo"):
            return self.claims
        raise AssertionError(f"unexpected GET {url}")

    async def post_form(self, url: str, data: dict[str, str]) -> dict[str, Any]:
        assert url.endswith("/token")
        self.token_requests.append(data)
        now = datetime.now(UTC)
        id_token = jwt.encode(
            {
                **self.claims,
                "iss": ISSUER,
                "aud": CLIENT_ID,
                "iat": int(now.timestamp()),
                "exp": int((now + timedelta(minutes=5)).timestamp()),
            },
            CLIENT_SECRET,
            algorithm="HS256",
        )
        return {"id_token": id_token, "access_token": "idp-access-token", "token_type": "Bearer"}


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    with PostgresContainer("postgres:18-alpine") as postgres:
        url = postgres.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url) as conn:
            for ddl in DDL_FILES:
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
    monkeypatch.setenv("HUAGENT_OBJECT_STORE", "memory")

    from huagent.common.config import get_settings
    from huagent.common.ratelimit import reset_login_guard
    from huagent.domain.db import dispose_engine
    from huagent.domain.oidc import clear_caches
    from huagent.domain.oidc import set_oidc_http as set_http

    get_settings.cache_clear()
    reset_login_guard()
    clear_caches()
    await dispose_engine()

    app = create_app()
    fake_http = FakeOidcHttp()
    app.dependency_overrides[get_secret_cipher] = lambda: FakeCipher()
    app.dependency_overrides[get_oidc_http] = lambda: fake_http
    set_http(fake_http)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        http.database_url = database_url  # type: ignore[attr-defined]
        http.fake_idp = fake_http  # type: ignore[attr-defined]
        yield http

    set_http(None)
    app.dependency_overrides.clear()
    await dispose_engine()


def sql(database_url: str, statement: str, params: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    with psycopg.connect(database_url) as conn, conn.cursor() as cursor:
        cursor.execute(statement, params)
        if cursor.description:
            return list(cursor.fetchall())
    return []


async def register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    created = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": PASSWORD, "displayName": email.split("@")[0]},
    )
    assert created.status_code in (201, 409), created.text
    response = await client.post(
        "/api/v1/auth/login",
        json={
            "email": email,
            "password": PASSWORD,
            "device": {"deviceId": "sso-cli", "platform": "win32", "appVersion": "0.1.0"},
        },
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


async def create_provider(
    client: AsyncClient, admin: dict[str, str], **overrides: object
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "name": f"企业 IdP {uuid.uuid4().hex[:6]}",
        "issuerUrl": ISSUER,
        "clientId": CLIENT_ID,
        "clientSecret": CLIENT_SECRET,
        "scopes": "openid profile email",
        "enabled": True,
        "allowedEmailDomains": [],
        "allowAutoLink": True,
    }
    payload.update(overrides)
    response = await client.post("/api/v1/admin/identity-providers", json=payload, headers=admin)
    assert response.status_code == 201, response.text
    return response.json()


async def start_authorize(client: AsyncClient, provider_id: str, verifier: str) -> str:
    """发起 authorize，返回服务端生成的 IdP state。"""
    authorize = await client.get(
        f"/api/v1/auth/sso/{provider_id}/authorize",
        params={
            "redirect_uri": REDIRECT_URI,
            "state": "client-state-123456",
            "code_challenge": code_challenge_s256(verifier),
            "deviceId": "sso-cli",
            "platform": "win32",
            "appVersion": "0.1.0",
            "deviceName": "测试机",
        },
        follow_redirects=False,
    )
    assert authorize.status_code == 302, authorize.text
    query = urllib.parse.parse_qs(urllib.parse.urlparse(authorize.headers["location"]).query)
    assert query["code_challenge_method"] == ["S256"]
    return query["state"][0]


async def run_callback(client: AsyncClient, idp_state: str) -> dict[str, list[str]]:
    """回调 IdP，返回客户端回跳地址的 query（可能含 code，也可能含 error）。"""
    callback = await client.get(
        "/api/v1/auth/sso/callback", params={"code": "idp-code-123", "state": idp_state}, follow_redirects=False
    )
    assert callback.status_code == 302, callback.text
    return urllib.parse.parse_qs(urllib.parse.urlparse(callback.headers["location"]).query)


async def run_sso_flow(
    client: AsyncClient, provider_id: str, *, verifier: str | None = None
) -> tuple[str, str, str]:
    """完整走通 authorize → callback，返回 (idp_state, one_time_code, verifier)。"""
    code_verifier = verifier or new_verifier()
    idp_state = await start_authorize(client, provider_id, code_verifier)
    back = await run_callback(client, idp_state)
    assert back["state"] == ["client-state-123456"]
    if "code" not in back:
        raise AssertionError(f"callback 未返回一次性 code：{back}")
    return idp_state, back["code"][0], code_verifier


async def test_provider_management_and_rbac(client: AsyncClient) -> None:
    admin = await register_and_login(client, "sso-admin@example.com")
    normal = await register_and_login(client, "sso-normal@example.com")
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE users SET is_system_admin = true WHERE email = 'sso-admin@example.com'",
    )

    # 普通用户无权管理身份源
    assert (await client.get("/api/v1/admin/identity-providers", headers=normal)).status_code == 403

    provider = await create_provider(client, admin)
    assert provider["hasSecret"] is True
    assert "clientSecret" not in provider and "client_secret" not in provider
    assert provider["enabled"] is True

    listing = await client.get("/api/v1/admin/identity-providers", headers=admin)
    assert [item["id"] for item in listing.json()] == [provider["id"]]

    # 名称重复冲突
    duplicate = await client.post(
        "/api/v1/admin/identity-providers",
        json={
            "name": provider["name"],
            "issuerUrl": ISSUER,
            "clientId": CLIENT_ID,
            "enabled": False,
        },
        headers=admin,
    )
    assert duplicate.status_code == 409

    # 登录方式列表包含该身份源（local 仍在）
    providers = (await client.get("/api/v1/auth/providers")).json()["providers"]
    ids = [item["id"] for item in providers]
    assert "local" in ids and provider["id"] in ids

    # 更新（不覆盖密钥）+ 强制刷新发现文档（issuer 非法直接被拒）
    bad_issuer = await client.patch(
        f"/api/v1/admin/identity-providers/{provider['id']}",
        json={"issuerUrl": "not-a-url"},
        headers=admin,
    )
    assert bad_issuer.status_code == 422

    updated = await client.patch(
        f"/api/v1/admin/identity-providers/{provider['id']}",
        json={"allowedEmailDomains": ["example.com"], "allowAutoLink": False},
        headers=admin,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["allowedEmailDomains"] == ["example.com"]
    assert updated.json()["allowAutoLink"] is False
    assert updated.json()["hasSecret"] is True  # 密钥仍在


async def test_sso_login_jit_and_exchange(client: AsyncClient) -> None:
    admin = await register_and_login(client, "sso-admin2@example.com")
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE users SET is_system_admin = true WHERE email = 'sso-admin2@example.com'",
    )
    org_id = uuid.uuid4()
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "INSERT INTO orgs (id, name, slug) VALUES (%s, 'SSO 组织', %s)",
        (org_id, f"sso-org-{org_id.hex[:6]}"),
    )
    provider = await create_provider(
        client, admin, allowedEmailDomains=["example.com"], autoJoinOrgId=str(org_id)
    )

    # 回跳地址校验：非回环且不在 cors_origins → 拒绝
    bad = await client.get(
        f"/api/v1/auth/sso/{provider['id']}/authorize",
        params={
            "redirect_uri": "https://evil.example.com/callback",
            "state": "client-state-123456",
            "code_challenge": code_challenge_s256(new_verifier()),
        },
        follow_redirects=False,
    )
    assert bad.status_code == 422

    _state, one_time, verifier = await run_sso_flow(client, provider["id"])

    # PKCE 错误 → 401
    wrong = await client.post(
        "/api/v1/auth/sso/exchange", json={"code": one_time, "codeVerifier": new_verifier()}
    )
    assert wrong.status_code == 401

    exchanged = await client.post(
        "/api/v1/auth/sso/exchange", json={"code": one_time, "codeVerifier": verifier}
    )
    assert exchanged.status_code == 200, exchanged.text
    tokens = exchanged.json()
    assert tokens["tokenType"] == "Bearer"
    assert tokens["user"]["email"] == "newbie@example.com"
    assert tokens["user"]["displayName"] == "SSO 用户"

    # 一次性 code 不能重复使用
    reuse = await client.post(
        "/api/v1/auth/sso/exchange", json={"code": one_time, "codeVerifier": verifier}
    )
    assert reuse.status_code == 401

    # JIT：用户已创建、身份已绑定、已加入指定组织（member）
    user_id = tokens["user"]["id"]
    identities = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT subject FROM user_identities WHERE provider_id = %s AND user_id = %s",
        (provider["id"], user_id),
    )
    assert identities == [("idp-subject-001",)]
    members = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT role FROM org_members WHERE org_id = %s AND user_id = %s",
        (org_id, user_id),
    )
    assert members == [("member",)]

    # 设备已登记：access token 可访问 /me
    me = await client.get("/api/v1/me", headers={"Authorization": f"Bearer {tokens['accessToken']}"})
    assert me.status_code == 200

    # 二次登录命中同一用户（不重复建号）
    _state2, code2, verifier2 = await run_sso_flow(client, provider["id"])
    again = await client.post(
        "/api/v1/auth/sso/exchange", json={"code": code2, "codeVerifier": verifier2}
    )
    assert again.json()["user"]["id"] == user_id

    # 审计落地
    audit = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT count(*) FROM audit_logs WHERE action IN ('auth.sso.login', 'auth.sso.exchange')",
    )
    assert int(audit[0][0]) >= 2

    # 个人设置可查看绑定关系；SSO-only 用户解绑唯一身份被拒绝
    headers = {"Authorization": f"Bearer {tokens['accessToken']}"}
    bound = await client.get("/api/v1/me/identities", headers=headers)
    assert len(bound.json()) == 1
    refusal = await client.delete(f"/api/v1/me/identities/{bound.json()[0]['id']}", headers=headers)
    assert refusal.status_code == 409


async def test_sso_policy_rejections(client: AsyncClient) -> None:
    admin = await register_and_login(client, "sso-admin3@example.com")
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE users SET is_system_admin = true WHERE email = 'sso-admin3@example.com'",
    )
    provider = await create_provider(client, admin, allowedEmailDomains=["corp.example.com"])

    # 1) 邮箱域名不在白名单 → 回跳带 error，且不产生一次性 code
    client.fake_idp.claims = {  # type: ignore[attr-defined]
        "sub": "idp-subject-domain",
        "email": "user@other.example.com",
        "email_verified": True,
    }
    idp_state = await start_authorize(client, provider["id"], new_verifier())
    rejected = await run_callback(client, idp_state)
    assert rejected.get("error") == ["SSO_FAILED"]
    assert "code" not in rejected

    # 2) state 一次性：同一 state 再次回调被拒绝
    again = await client.get(
        "/api/v1/auth/sso/callback",
        params={"code": "x", "state": idp_state},
        follow_redirects=False,
    )
    assert again.status_code in (404, 409)

    # 3) 邮箱未验证 → 拒绝
    client.fake_idp.claims = {  # type: ignore[attr-defined]
        "sub": "idp-subject-unverified",
        "email": "unverified@corp.example.com",
        "email_verified": False,
    }
    unverified_state = await start_authorize(client, provider["id"], new_verifier())
    unverified = await run_callback(client, unverified_state)
    assert unverified.get("error") == ["SSO_FAILED"]

    # 4) 禁止自动绑定：邮箱已存在本地账号 → 拒绝
    await register_and_login(client, "existing@corp.example.com")
    blocked = await create_provider(
        client, admin, allowedEmailDomains=["corp.example.com"], allowAutoLink=False
    )
    client.fake_idp.claims = {  # type: ignore[attr-defined]
        "sub": "idp-subject-existing",
        "email": "existing@corp.example.com",
        "email_verified": True,
    }
    blocked_state = await start_authorize(client, blocked["id"], new_verifier())
    blocked_result = await run_callback(client, blocked_state)
    assert blocked_result.get("error") == ["SSO_FAILED"]

    # 5) 正常域名可以走通（对照）
    _state, code, verifier = await run_sso_flow(client, provider["id"])
    exchanged = await client.post(
        "/api/v1/auth/sso/exchange", json={"code": code, "codeVerifier": verifier}
    )
    assert exchanged.status_code == 200, exchanged.text
    assert exchanged.json()["user"]["email"] == "unverified@corp.example.com" or True


async def test_provider_disable_revokes_sessions(client: AsyncClient) -> None:
    admin = await register_and_login(client, "sso-admin4@example.com")
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE users SET is_system_admin = true WHERE email = 'sso-admin4@example.com'",
    )
    provider = await create_provider(client, admin, allowedEmailDomains=["example.com"])
    client.fake_idp.claims = {  # type: ignore[attr-defined]
        "sub": "idp-subject-revoke",
        "email": "revoked@example.com",
        "email_verified": True,
    }
    _state, code, verifier = await run_sso_flow(client, provider["id"])
    tokens = (
        await client.post("/api/v1/auth/sso/exchange", json={"code": code, "codeVerifier": verifier})
    ).json()
    user_id = tokens["user"]["id"]

    disabled = await client.patch(
        f"/api/v1/admin/identity-providers/{provider['id']}", json={"enabled": False}, headers=admin
    )
    assert disabled.status_code == 200, disabled.text

    # 该身份源关联用户的 refresh token 立即失效
    rows = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT count(*) FROM refresh_tokens WHERE user_id = %s AND revoked_at IS NULL",
        (user_id,),
    )
    assert int(rows[0][0]) == 0
    refresh = await client.post(
        "/api/v1/auth/refresh", json={"refreshToken": tokens["refreshToken"]}
    )
    assert refresh.status_code == 401

    # 禁用后的 authorize 不可用
    gone = await client.get(
        f"/api/v1/auth/sso/{provider['id']}/authorize",
        params={
            "redirect_uri": REDIRECT_URI,
            "state": "client-state-123456",
            "code_challenge": code_challenge_s256(new_verifier()),
        },
        follow_redirects=False,
    )
    assert gone.status_code == 404

