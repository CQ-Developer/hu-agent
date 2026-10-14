"""集成测试：管理员 CLI（huagent-admin）——首个系统管理员引导与账号运维。

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
DEVICE = {"deviceId": "cli-test", "platform": "linux", "appVersion": "0.1.0"}


@pytest.fixture(scope="module")
def database_url() -> Iterator[str]:
    with PostgresContainer("postgres:18-alpine") as postgres:
        url = postgres.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url) as conn:
            for ddl in sorted(DDL_DIR.glob("V*.sql")):
                conn.execute(ddl.read_text(encoding="utf-8"))
        yield url


@pytest.fixture
def cli_env(database_url: str, monkeypatch: pytest.MonkeyPatch) -> str:
    async_url = database_url.replace("postgresql://", "postgresql+psycopg://")
    monkeypatch.setenv("HUAGENT_DATABASE_URL", async_url)
    monkeypatch.setenv("HUAGENT_SCHEMA_CHECK_ENABLED", "false")
    monkeypatch.setenv("HUAGENT_LOGIN_IP_LIMIT", "1000")
    monkeypatch.setenv("HUAGENT_LOGIN_FAIL_THRESHOLD", "1000")

    from huagent.common.config import get_settings

    get_settings.cache_clear()
    return database_url


@pytest.fixture
async def client(cli_env: str, monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    if sys.platform == "win32":
        import asyncio
        import selectors

        asyncio.set_event_loop(asyncio.SelectorEventLoop(selectors.SelectSelector()))

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


async def run_cli(*argv: str) -> int:
    """在测试事件循环内直接调 CLI 分发（等价于 `huagent-admin …`，但不嵌套 asyncio.run）。"""
    from huagent.admin import _dispatch, build_parser

    return await _dispatch(build_parser().parse_args(list(argv)))


async def _login(client: AsyncClient, email: str, password: str) -> int:
    response = await client.post("/api/v1/auth/login", json={"email": email, "password": password, "device": DEVICE})
    return response.status_code


async def test_create_admin_then_login(client: AsyncClient, cli_env: str, capsys: pytest.CaptureFixture[str]) -> None:
    """陌生人部署后的第一步：用 CLI 创建首个系统管理员并登录。"""
    email = f"first-admin-{uuid.uuid4().hex[:6]}@example.com"
    password = "Bootstrap-Passphrase-2026"
    assert await run_cli("create-admin", "--email", email, "--password", password) == 0
    output = capsys.readouterr().out
    assert "已创建系统管理员" in output

    login = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": password, "device": DEVICE}
    )
    assert login.status_code == 200, login.text
    assert sql(cli_env, "SELECT is_system_admin FROM users WHERE email = %s", (email,))[0][0] is True

    # 管理台依赖的运维接口对系统管理员开放（CLI 创建的账号即可用）
    headers = {"authorization": f"Bearer {login.json()['accessToken']}"}
    settings = await client.get("/api/v1/admin/settings", headers=headers)
    assert settings.status_code == 200, settings.text
    audit = await client.get("/api/v1/admin/audit", params={"action": "admin.cli."}, headers=headers)
    assert audit.status_code == 200
    assert any(item["action"].startswith("admin.cli.") for item in audit.json()["items"])


async def test_generated_password_is_printed_once(cli_env: str, capsys: pytest.CaptureFixture[str]) -> None:
    email = f"generated-{uuid.uuid4().hex[:6]}@example.com"
    assert await run_cli("create-admin", "--email", email) == 0
    output = capsys.readouterr().out
    assert "生成一次性口令" in output
    # 生成的口令必须真的能入库（长度与弱口令校验通过）
    assert sql(cli_env, "SELECT password_hash IS NOT NULL FROM users WHERE email = %s", (email,))[0][0] is True


async def test_promote_existing_user_and_reset_password(client: AsyncClient, cli_env: str) -> None:
    email = f"promote-{uuid.uuid4().hex[:6]}@example.com"
    created = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": "Member-Passphrase-2026", "displayName": "成员"}
    )
    assert created.status_code == 201, created.text
    assert sql(cli_env, "SELECT is_system_admin FROM users WHERE email = %s", (email,))[0][0] is False

    # 提升为系统管理员 + 重置密码
    assert await run_cli("create-admin", "--email", email, "--password", "Promoted-Passphrase-2026") == 0
    assert sql(cli_env, "SELECT is_system_admin FROM users WHERE email = %s", (email,))[0][0] is True
    assert await _login(client, email, "Promoted-Passphrase-2026") == 200
    assert await _login(client, email, "Member-Passphrase-2026") == 401

    # 重置密码会撤销旧会话
    assert await _login(client, email, "Promoted-Passphrase-2026") == 200
    assert await run_cli("reset-password", "--email", email, "--password", "Rotated-Passphrase-2026") == 0
    assert sql(cli_env, "SELECT count(*) FROM refresh_tokens WHERE user_id = "
                        "(SELECT id FROM users WHERE email = %s) AND revoked_at IS NULL", (email,))[0][0] == 0
    assert await _login(client, email, "Rotated-Passphrase-2026") == 200


async def test_list_disable_enable_user(client: AsyncClient, cli_env: str, capsys: pytest.CaptureFixture[str]) -> None:
    email = f"toggle-{uuid.uuid4().hex[:6]}@example.com"
    created = await client.post(
        "/api/v1/auth/register", json={"email": email, "password": "Toggle-Passphrase-2026", "displayName": "待禁用"}
    )
    assert created.status_code == 201, created.text

    assert await run_cli("list-users", "--query", email) == 0
    assert email in capsys.readouterr().out

    assert await run_cli("disable-user", "--email", email) == 0
    assert sql(cli_env, "SELECT status FROM users WHERE email = %s", (email,))[0][0] == "disabled"
    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "Toggle-Passphrase-2026", "device": DEVICE}
    )
    assert response.status_code in (401, 403), response.text

    assert await run_cli("enable-user", "--email", email) == 0
    assert await _login(client, email, "Toggle-Passphrase-2026") == 200

    # 不存在的账号：返回码 1（脚本可判断）
    assert await run_cli("disable-user", "--email", f"missing-{uuid.uuid4().hex[:6]}@example.com") == 1


async def test_schema_guard_blocks_uninitialized_database(monkeypatch: pytest.MonkeyPatch) -> None:
    """库未初始化/不可达时 CLI 拒绝执行（返回码 2），避免写出半套数据。"""
    monkeypatch.setenv("HUAGENT_DATABASE_URL", "postgresql+psycopg://nobody:nobody@127.0.0.1:1/none")
    from huagent.common.config import get_settings
    from huagent.domain.db import dispose_engine

    get_settings.cache_clear()
    assert await run_cli("list-users") == 2
    await dispose_engine()
    get_settings.cache_clear()


def test_module_runnable_as_program() -> None:
    """`python -m huagent.admin --help` 可用（控制台脚本入口同理）。"""
    import subprocess

    result = subprocess.run(
        [sys.executable, "-m", "huagent.admin", "--help"], capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0
    assert "create-admin" in result.stdout
