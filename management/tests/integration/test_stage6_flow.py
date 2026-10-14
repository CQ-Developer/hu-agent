"""阶段 6 服务端流程集成测试（design 6.6 / 6.7 / 6.11）。

覆盖：工作空间关联、快照乐观锁与校验、配额、保留与删除规则、用量聚合、
价格估算、统计范围权限、资源激活明细、worker 任务（分区/清理/邀请/审批）。

默认跳过（需要 Docker）；运行：
    HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
"""

from __future__ import annotations

import hashlib
import io
import os
import sys
import uuid
import zipfile
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

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

DDL_FILES = [
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0001__init.sql",
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0002__stage5.sql",
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0003__stage6.sql",
]
PASSWORD = "Str0ng-Passphrase-2026"
DEVICE = {"deviceId": "device-stage6", "platform": "win32", "appVersion": "0.1.0"}


def snapshot_zip(marker: str = "hello") -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("notes.txt", marker)
        archive.writestr(".hu/settings.json", "{}")
    return buffer.getvalue()


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

    get_settings.cache_clear()
    reset_login_guard()
    await dispose_engine()

    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        http.database_url = database_url  # type: ignore[attr-defined]
        yield http

    await dispose_engine()


async def register_and_login(client: AsyncClient, email: str) -> dict[str, str]:
    created = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": PASSWORD, "displayName": email.split("@")[0]},
    )
    assert created.status_code in (201, 409), created.text
    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD, "device": DEVICE}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


def sql(database_url: str, statement: str, params: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    with psycopg.connect(database_url) as conn, conn.cursor() as cursor:
        cursor.execute(statement, params)
        if cursor.description:
            return list(cursor.fetchall())
    return []


def memory_store() -> Any:
    from huagent.storage.objects import get_object_store

    return get_object_store("snapshots")


async def test_snapshot_lifecycle_conflict_and_quota(client: AsyncClient) -> None:
    headers = await register_and_login(client, "sync@example.com")
    other = await register_and_login(client, "other-sync@example.com")

    created = await client.post("/api/v1/workspaces", json={"name": "本地工作空间"}, headers=headers)
    assert created.status_code == 201, created.text
    workspace_id = created.json()["id"]
    assert (await client.get("/api/v1/workspaces", headers=headers)).json()[0]["id"] == workspace_id

    # 非 owner 不可见
    assert (await client.get(f"/api/v1/workspaces/{workspace_id}/snapshots", headers=other)).status_code == 404

    payload = snapshot_zip()
    digest = f"sha256:{hashlib.sha256(payload).hexdigest()}"

    # 1) init：乐观锁 baseline 0
    init = await client.post(
        f"/api/v1/workspaces/{workspace_id}/snapshots:init",
        json={
            "baseVersion": 0,
            "sizeBytes": len(payload),
            "fileCount": 2,
            "manifestDigest": "sha256:manifest-1",
        },
        headers=headers,
    )
    assert init.status_code == 200, init.text
    snapshot = init.json()
    assert snapshot["version"] == 1
    assert snapshot["uploadUrl"].startswith("memory-put://")

    # 2a) 对象尚未上传 → 拒绝（提示重新上传）
    missing = await client.post(
        f"/api/v1/snapshots/{snapshot['snapshotId']}:complete",
        json={"digest": digest},
        headers=headers,
    )
    assert missing.status_code == 422
    assert missing.json()["code"] == "VALIDATION_FAILED"

    # 2b) 对象存在但 digest 不符 → 422，对象删除、快照 aborted
    store = memory_store()
    object_key_1 = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT object_key FROM workspace_snapshots WHERE id = %s",
        (snapshot["snapshotId"],),
    )[0][0]
    store.put(str(object_key_1), payload)  # type: ignore[attr-defined]
    # 快照必须落在快照桶，而不是技能包桶
    from huagent.storage.objects import get_object_store

    assert get_object_store("skills").exists(str(object_key_1)) is False
    wrong = await client.post(
        f"/api/v1/snapshots/{snapshot['snapshotId']}:complete",
        json={"digest": f"sha256:{'0' * 64}"},
        headers=headers,
    )
    assert wrong.status_code == 422
    assert wrong.json()["code"] == "PACKAGE_INVALID"
    assert store.exists(str(object_key_1)) is False  # type: ignore[attr-defined]
    assert sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT status FROM workspace_snapshots WHERE id = %s",
        (snapshot["snapshotId"],),
    ) == [("aborted",)]

    # 3) 重新上传：版本号继续递增（aborted 不占用最新版本，但仍占版本号）
    again = await client.post(
        f"/api/v1/workspaces/{workspace_id}/snapshots:init",
        json={"baseVersion": 0, "sizeBytes": len(payload), "fileCount": 2, "manifestDigest": "sha256:manifest-1"},
        headers=headers,
    )
    assert again.status_code == 200
    assert again.json()["version"] == 2

    # 4) 直传对象（测试内存存储）后 complete 成功
    object_key = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT object_key FROM workspace_snapshots WHERE id = %s",
        (again.json()["snapshotId"],),
    )[0][0]
    store.put(str(object_key), payload)  # type: ignore[attr-defined]

    done = await client.post(
        f"/api/v1/snapshots/{again.json()['snapshotId']}:complete",
        json={"digest": digest},
        headers=headers,
    )
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "active"

    latest = await client.get(f"/api/v1/workspaces/{workspace_id}/snapshots/latest", headers=headers)
    assert latest.json()["version"] == 2
    assert latest.json()["fileCount"] == 2
    assert latest.json()["manifestDigest"] == "sha256:manifest-1"

    quota = await client.get(f"/api/v1/workspaces/{workspace_id}/quota", headers=headers)
    assert quota.json()["usedBytes"] == len(payload)

    # 5) 过期基线 → 409 冲突，带最新版本
    conflict = await client.post(
        f"/api/v1/workspaces/{workspace_id}/snapshots:init",
        json={"baseVersion": 0, "sizeBytes": len(payload), "fileCount": 2, "manifestDigest": "x"},
        headers=headers,
    )
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "VERSION_CONFLICT"
    assert conflict.json()["details"]["latestVersion"] == 2

    # 6) 再传一个版本（v3），随后删除非最新且未 pin 的 v2；pin 与最新不可删
    init3 = await client.post(
        f"/api/v1/workspaces/{workspace_id}/snapshots:init",
        json={"baseVersion": 2, "sizeBytes": len(payload), "fileCount": 2, "manifestDigest": "sha256:manifest-3"},
        headers=headers,
    )
    snapshot3 = init3.json()
    object_key3 = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT object_key FROM workspace_snapshots WHERE id = %s",
        (snapshot3["snapshotId"],),
    )[0][0]
    store.put(str(object_key3), payload)  # type: ignore[attr-defined]
    await client.post(
        f"/api/v1/snapshots/{snapshot3['snapshotId']}:complete", json={"digest": digest}, headers=headers
    )

    listing = await client.get(f"/api/v1/workspaces/{workspace_id}/snapshots", headers=headers)
    assert [item["version"] for item in listing.json()["items"]] == [3, 2]

    pin = await client.post(f"/api/v1/snapshots/{again.json()['snapshotId']}:pin", headers=headers)
    assert pin.json()["pinned"] is True
    assert (
        await client.delete(f"/api/v1/snapshots/{again.json()['snapshotId']}", headers=headers)
    ).status_code == 409  # pinned
    assert (
        await client.delete(f"/api/v1/snapshots/{snapshot3['snapshotId']}", headers=headers)
    ).status_code == 409  # 最新

    # 解锁后删除 v2
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE workspace_snapshots SET pinned = false WHERE id = %s",
        (again.json()["snapshotId"],),
    )
    deleted = await client.delete(f"/api/v1/snapshots/{again.json()['snapshotId']}", headers=headers)
    assert deleted.status_code == 200
    assert store.exists(str(object_key)) is False  # type: ignore[attr-defined]
    quota_after = await client.get(f"/api/v1/workspaces/{workspace_id}/quota", headers=headers)
    assert quota_after.json()["usedBytes"] == len(payload)

    # 7) 下载地址
    url = await client.get(f"/api/v1/snapshots/{snapshot3['snapshotId']}/download-url", headers=headers)
    assert url.status_code == 200
    assert url.json()["url"].startswith("memory://")
    assert url.json()["expiresIn"] == 900

    # 8) 配额超限：把用户配额改小
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE system_settings SET value = '10'::jsonb WHERE key = 'quota.user_bytes'",
    )
    over = await client.post(
        f"/api/v1/workspaces/{workspace_id}/snapshots:init",
        json={"baseVersion": 3, "sizeBytes": len(payload), "fileCount": 2, "manifestDigest": "x"},
        headers=headers,
    )
    assert over.status_code == 402
    assert over.json()["code"] == "QUOTA_EXCEEDED"
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE system_settings SET value = '10737418240'::jsonb WHERE key = 'quota.user_bytes'",
    )


async def test_usage_aggregation_pricing_and_stats(client: AsyncClient) -> None:
    from huagent.domain.db import get_session_factory
    from huagent.worker.jobs import aggregate_usage

    owner = await register_and_login(client, "stats-owner@example.com")
    member = await register_and_login(client, "stats-member@example.com")
    outsider = await register_and_login(client, "stats-outsider@example.com")
    admin = await register_and_login(client, "stats-sysadmin@example.com")

    # 组织与团队（复用阶段 5 流程，简明版：直接 SQL 造组织/团队/成员）
    org_id = uuid.uuid4()
    team_id = uuid.uuid4()
    owner_id = (await client.get("/api/v1/me", headers=owner)).json()["id"]
    member_id = (await client.get("/api/v1/me", headers=member)).json()["id"]
    admin_id = (await client.get("/api/v1/me", headers=admin)).json()["id"]
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "INSERT INTO orgs (id, name, slug, created_by) VALUES (%s, '统计组织', %s, %s)",
        (org_id, f"stats-org-{org_id.hex[:6]}", owner_id),
    )
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "INSERT INTO org_members (org_id, user_id, role) VALUES (%s, %s, 'admin'), (%s, %s, 'member')",
        (org_id, owner_id, org_id, member_id),
    )
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "INSERT INTO teams (id, org_id, name, created_by) VALUES (%s, %s, '统计团队', %s)",
        (team_id, org_id, owner_id),
    )
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "INSERT INTO team_members (team_id, user_id, role) VALUES (%s, %s, 'admin'), (%s, %s, 'member')",
        (team_id, owner_id, team_id, member_id),
    )
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE users SET is_system_admin = true WHERE id = %s",
        (admin_id,),
    )
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "INSERT INTO model_prices (provider, model, input_per_1k, output_per_1k, effective_from) "
        "VALUES ('deepseek', 'deepseek-chat', 0.001, 0.002, current_date - 1)",
    )

    occurred = datetime.now(UTC) - timedelta(hours=3)
    events = []
    for index in range(3):
        events.append(
            {
                "eventId": str(uuid.uuid7()),
                "occurredAt": occurred.isoformat(),
                "deviceId": "device-stage6",
                "provider": "deepseek",
                "model": "deepseek-chat",
                "inputTokens": 1000 + index,
                "outputTokens": 100,
                "requests": 1,
                "status": "error" if index == 2 else "success",
                "teamId": str(team_id),
            }
        )
    batch = await client.post("/api/v1/usage:batch", json={"events": events}, headers=member)
    assert batch.status_code == 200, batch.text
    assert batch.json()["accepted"] == 3

    async with get_session_factory()() as session:
        aggregated = await aggregate_usage(session)
    assert aggregated >= 1

    # 个人用量：按模型聚合，估算花费按价格表计算
    self_stats = await client.get("/api/v1/stats/usage?scope=self&groupBy=model", headers=member)
    assert self_stats.status_code == 200, self_stats.text
    body = self_stats.json()
    assert body["totals"]["inputTokens"] == 3003
    assert body["totals"]["outputTokens"] == 300
    assert body["totals"]["errors"] == 1
    assert body["rows"][0]["model"] == "deepseek-chat"
    # 3003/1000*0.001 + 300/1000*0.002 = 0.003603
    assert abs(body["totals"]["estimatedCost"] - 0.003603) < 1e-6

    by_day = await client.get("/api/v1/stats/usage?scope=self&groupBy=day", headers=member)
    assert len(by_day.json()["rows"]) == 1

    # 越权与范围断言
    member_team = await client.get(
        f"/api/v1/stats/usage?scope=team&team_id={team_id}", headers=member
    )
    assert member_team.status_code == 403
    assert (
        await client.get("/api/v1/stats/usage?scope=global", headers=owner)
    ).status_code == 403
    team_stats = await client.get(
        f"/api/v1/stats/usage?scope=team&team_id={team_id}&groupBy=member", headers=owner
    )
    assert team_stats.status_code == 200
    assert len(team_stats.json()["rows"]) == 1
    global_stats = await client.get("/api/v1/stats/usage?scope=global&groupBy=org", headers=admin)
    assert global_stats.status_code == 200
    assert global_stats.json()["totals"]["requests"] == 3

    # 其他用户的 self 不含本团队数据
    other_self = await client.get("/api/v1/stats/usage?scope=self", headers=outsider)
    assert other_self.json()["totals"]["requests"] == 0

    # 激活明细：成员上报后本人可见，团队管理员可见成员维度
    reported = await client.post(
        "/api/v1/me/activations:report",
        json={
            "deviceId": "device-stage6",
            "scope": "global",
            "items": [{"type": "skill", "source": "local", "name": "local-notes", "enabled": True}],
        },
        headers=member,
    )
    assert reported.status_code == 200
    self_act = await client.get("/api/v1/stats/activations?scope=self", headers=member)
    assert self_act.json()["items"][0]["name"] == "local-notes"
    assert self_act.json()["items"][0]["enabled"] is True
    team_act = await client.get(f"/api/v1/stats/activations?scope=team&team_id={team_id}", headers=owner)
    assert len(team_act.json()["items"]) == 1
    outsider_act = await client.get(
        f"/api/v1/stats/activations?scope=team&team_id={team_id}", headers=outsider
    )
    assert outsider_act.status_code == 404


async def test_worker_jobs(client: AsyncClient) -> None:
    from huagent.domain.db import get_session_factory
    from huagent.worker.jobs import (
        cleanup_snapshots,
        maintain_usage_partitions,
        mark_expired_invitations,
        remind_and_expire_approvals,
    )

    # 分区维护：至少存在当月与下月分区
    async with get_session_factory()() as session:
        await maintain_usage_partitions(session)
    parts = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid "
        "JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname = 'usage_events'",
    )
    names = {str(row[0]) for row in parts}
    now = datetime.now(UTC)
    this_month = f"usage_events_{now.year}{now.month:02d}"
    assert this_month in names

    # 邀请过期
    headers = await register_and_login(client, "worker-owner@example.com")
    sql(
        client.database_url,  # type: ignore[attr-defined]
        """
        INSERT INTO invitations (type, org_id, email, role, token_hash, expires_at)
        SELECT 'org', id, 'expired@example.com', 'member', 'hash-expired', now() - interval '1 day'
        FROM orgs LIMIT 1
        """,
    )
    async with get_session_factory()() as session:
        expired = await mark_expired_invitations(session)
    assert expired >= 1

    # 审批 48h 提醒 + 7 天 stale
    sql(
        client.database_url,  # type: ignore[attr-defined]
        """
        INSERT INTO approval_requests (type, requester_id, target_type, target_id, payload, created_at)
        SELECT 'org_create', id, 'org_slug', %s, '{}'::jsonb, now() - interval '8 days'
        FROM users WHERE email = 'worker-owner@example.com'
        """,
        (f"stale-{uuid.uuid4().hex[:6]}",),
    )
    async with get_session_factory()() as session:
        changed = await remind_and_expire_approvals(session)
    assert changed >= 1
    statuses = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT status FROM approval_requests WHERE created_at < now() - interval '7 days'",
    )
    assert all(row[0] == "stale" for row in statuses)

    # 快照清理：制造一个 25 小时前的 uploading 记录 → aborted
    created = await client.post("/api/v1/workspaces", json={"name": "清理测试"}, headers=headers)
    workspace_id = created.json()["id"]
    init = await client.post(
        f"/api/v1/workspaces/{workspace_id}/snapshots:init",
        json={"baseVersion": 0, "sizeBytes": 10, "fileCount": 1, "manifestDigest": "x"},
        headers=headers,
    )
    sql(
        client.database_url,  # type: ignore[attr-defined]
        "UPDATE workspace_snapshots SET created_at = now() - interval '25 hours' WHERE id = %s",
        (init.json()["snapshotId"],),
    )
    async with get_session_factory()() as session:
        cleaned = await cleanup_snapshots(session)
    assert cleaned >= 1
    state = sql(
        client.database_url,  # type: ignore[attr-defined]
        "SELECT status FROM workspace_snapshots WHERE id = %s",
        (init.json()["snapshotId"],),
    )
    assert state == [("aborted",)]


def test_timestamps_are_monotonic_guard() -> None:
    """占位：确保时区工具可用（避免测试文件导入错误）。"""
    assert datetime.now(UTC) > datetime(2000, 1, 1, tzinfo=UTC)
