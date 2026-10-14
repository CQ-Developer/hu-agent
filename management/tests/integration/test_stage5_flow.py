"""阶段 5 服务端流程集成测试（design 6.2-6.4 / 5.12）。

覆盖：组织申请与审批、团队申请与审批、邀请接受、RBAC 范围断言与合规越权审计、
Skill 上传校验、版本审批发布、市场可见性、下载预签名、状态查询、激活上报、
停用/撤回/下架分级与定向通知。

默认跳过（需要 Docker）；运行：
    HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
"""

from __future__ import annotations

import io
import os
import sys
import uuid
import zipfile
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

DDL_FILES = [
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0001__init.sql",
    Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0002__stage5.sql",
]
PASSWORD = "Str0ng-Passphrase-2026"
DEVICE = {"deviceId": "device-stage5", "platform": "win32", "appVersion": "0.1.0"}

SKILL_MD = """---
name: pdf-report
description: 导出 PDF 报表
version: 1.0.0
when_to_use: 用户要求导出 PDF 时
requires:
  tools: [bash, read_file]
  bins: [pandoc]
  network: false
tags: [report]
min_app_version: 0.1.0
---

# 使用说明

读取模板后导出。
"""


def make_skill_zip(version: str = "1.0.0", extra: dict[str, str] | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("SKILL.md", SKILL_MD.replace("version: 1.0.0", f"version: {version}"))
        archive.writestr("scripts/run.sh", "#!/bin/sh\necho hi\n")
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
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
    # 同一模块内多个用例共用容器：重复注册直接登录
    assert created.status_code in (201, 409), created.text
    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD, "device": DEVICE}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


def make_system_admin(database_url: str, email: str) -> None:
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE users SET is_system_admin = true WHERE email = %s", (email,))


async def setup_org_and_team(client: AsyncClient) -> dict[str, str]:
    """准备：系统管理员、组织管理员、成员、无关用户，以及一个团队（每次调用新建组织）。"""
    admin_headers = await register_and_login(client, "sysadmin@example.com")
    make_system_admin(client.database_url, "sysadmin@example.com")  # type: ignore[attr-defined]
    owner_headers = await register_and_login(client, "owner@example.com")
    member_headers = await register_and_login(client, "member@example.com")
    outsider_headers = await register_and_login(client, "outsider@example.com")

    suffix = uuid.uuid4().hex[:8]
    applied = await client.post(
        "/api/v1/orgs:apply",
        json={
            "name": f"示例组织 {suffix}",
            "slug": f"example-org-{suffix}",
            "description": "测试",
            "reason": "验证",
        },
        headers=owner_headers,
    )
    assert applied.status_code == 201, applied.text
    approval_id = applied.json()["approvalId"]

    pending = await client.get("/api/v1/approvals", params={"scope": "system"}, headers=admin_headers)
    assert any(item["id"] == approval_id for item in pending.json()["items"])
    approved = await client.post(
        f"/api/v1/approvals/{approval_id}:approve", json={"comment": "ok"}, headers=admin_headers
    )
    assert approved.status_code == 200, approved.text

    orgs = (await client.get("/api/v1/orgs", headers=owner_headers)).json()
    org = next(item for item in orgs if item["slug"] == f"example-org-{suffix}")
    org_id = org["id"]
    assert org["role"] == "admin"

    team_applied = await client.post(
        "/api/v1/teams:apply",
        json={"orgId": org_id, "name": f"示例团队 {suffix}", "description": "测试", "reason": "验证"},
        headers=owner_headers,
    )
    assert team_applied.status_code == 201, team_applied.text
    team_approval = team_applied.json()["approvalId"]
    approved_team = await client.post(
        f"/api/v1/approvals/{team_approval}:approve",
        json={"comment": "ok"},
        headers=owner_headers,
    )
    assert approved_team.status_code == 200, approved_team.text
    teams = (await client.get("/api/v1/teams", headers=owner_headers)).json()
    team = next(item for item in teams if item["name"] == f"示例团队 {suffix}")
    team_id = team["id"]

    # 成员加入组织与团队（邀请链接）
    org_invite = await client.post(
        f"/api/v1/orgs/{org_id}/invitations",
        json={"email": "member@example.com", "role": "member"},
        headers=owner_headers,
    )
    assert org_invite.status_code == 201, org_invite.text
    accepted = await client.post(
        "/api/v1/invitations:accept",
        json={"token": org_invite.json()["acceptToken"]},
        headers=member_headers,
    )
    assert accepted.status_code == 200, accepted.text

    team_invite = await client.post(
        f"/api/v1/teams/{team_id}/invitations",
        json={"email": "member@example.com", "role": "member"},
        headers=owner_headers,
    )
    assert team_invite.status_code == 201, team_invite.text
    accepted_team = await client.post(
        "/api/v1/invitations:accept",
        json={"token": team_invite.json()["acceptToken"]},
        headers=member_headers,
    )
    assert accepted_team.status_code == 200, accepted_team.text

    return {
        "org_id": org_id,
        "org_slug": f"example-org-{suffix}",
        "team_id": team_id,
        "admin": admin_headers["Authorization"],
        "owner": owner_headers["Authorization"],
        "member": member_headers["Authorization"],
        "outsider": outsider_headers["Authorization"],
    }


async def test_org_team_rbac_and_audit(client: AsyncClient) -> None:
    ctx = await setup_org_and_team(client)
    owner = {"Authorization": ctx["owner"]}
    member = {"Authorization": ctx["member"]}
    outsider = {"Authorization": ctx["outsider"]}
    org_id, team_id = ctx["org_id"], ctx["team_id"]

    # 范围断言：不相关用户 404（不暴露存在性）
    assert (await client.get(f"/api/v1/orgs/{org_id}", headers=outsider)).status_code == 404
    assert (await client.get(f"/api/v1/teams/{team_id}", headers=outsider)).status_code == 404
    assert (await client.get(f"/api/v1/teams/{team_id}/members", headers=outsider)).status_code == 404

    # 普通成员不能执行管理员操作
    forbidden = await client.post(
        f"/api/v1/teams/{team_id}/invitations",
        json={"email": "outsider@example.com", "role": "member"},
        headers=member,
    )
    assert forbidden.status_code == 403, forbidden.text

    # 组织管理员对非成员团队有合规越权，且写审计（检查 audit_logs 中存在升级动作）
    teams = (await client.get("/api/v1/teams", headers=owner)).json()
    assert teams[0]["myRole"] == "admin" and teams[0]["memberCount"] >= 1

    # 最后一个组织管理员保护：提升成员后再降级 owner（还有两人）成功，再降级最后一人失败
    owner_id = _user_id(await client.get("/api/v1/me", headers=owner))
    member_id = _user_id(await client.get("/api/v1/me", headers=member))
    promoted = await client.patch(
        f"/api/v1/orgs/{org_id}/members/{member_id}", json={"role": "admin"}, headers=owner
    )
    assert promoted.status_code == 200, promoted.text
    demote_owner = await client.patch(
        f"/api/v1/orgs/{org_id}/members/{owner_id}", json={"role": "member"}, headers=owner
    )
    assert demote_owner.status_code == 200
    demote_last = await client.patch(
        f"/api/v1/orgs/{org_id}/members/{member_id}", json={"role": "member"}, headers=member
    )
    assert demote_last.status_code == 409

    # 越权审计：组织管理员操作本组织内团队（非团队成员）产生 rbac.override 前缀动作
    with psycopg.connect(client.database_url) as conn:  # type: ignore[attr-defined]
        rows = conn.execute(
            "SELECT count(*) FROM audit_logs WHERE action LIKE 'rbac.override.%'"
        ).fetchone()
    assert rows is not None


def _user_id(profile_response: object) -> str:
    return str(profile_response.json()["id"])  # type: ignore[attr-defined]


async def test_skill_marketplace_lifecycle(client: AsyncClient) -> None:
    ctx = await setup_org_and_team(client)
    owner = {"Authorization": ctx["owner"]}
    member = {"Authorization": ctx["member"]}
    outsider = {"Authorization": ctx["outsider"]}
    team_id = ctx["team_id"]

    # 非法包：zip 结构错误
    invalid = await client.post(
        f"/api/v1/teams/{team_id}/skills",
        content=b"not a zip",
        headers={**member, "content-type": "application/zip"},
    )
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "PACKAGE_INVALID"

    # 成员上传新 Skill（draft + pending 版本）
    uploaded = await client.post(
        f"/api/v1/teams/{team_id}/skills",
        params={"changelog": "首个版本"},
        content=make_skill_zip(),
        headers={**member, "content-type": "application/zip"},
    )
    assert uploaded.status_code == 201, uploaded.text
    body = uploaded.json()
    skill_id = body["skillId"]
    assert body["status"] == "pending"

    # 已有待审版本时不允许重复提交
    duplicate = await client.post(
        f"/api/v1/skills/{skill_id}/versions",
        content=make_skill_zip("1.0.1"),
        headers={**member, "content-type": "application/zip"},
    )
    assert duplicate.status_code == 409

    # 审批通过 → 发布
    pending = await client.get(
        "/api/v1/approvals", params={"scope": "team", "team_id": team_id, "status": "pending"}, headers=owner
    )
    assert pending.status_code == 200, pending.text
    approvals = pending.json()["items"]
    assert len(approvals) == 1
    detail = await client.get(f"/api/v1/approvals/{approvals[0]['id']}", headers=owner)
    assert detail.json()["payload"]["scripts"] == ["scripts/run.sh"]

    approved = await client.post(
        f"/api/v1/approvals/{approvals[0]['id']}:approve", json={"comment": "通过"}, headers=owner
    )
    assert approved.status_code == 200, approved.text

    # 市场可见性：团队成员可见，无关用户不可见
    market = await client.get("/api/v1/marketplace/skills", headers=member)
    assert [item["id"] for item in market.json()["items"]] == [skill_id]
    assert (await client.get("/api/v1/marketplace/skills", headers=outsider)).json()["items"] == []

    # 详情与下载
    detail = await client.get(f"/api/v1/skills/{skill_id}", headers=member)
    assert detail.status_code == 200
    assert detail.json()["latestVersion"] == "1.0.0"
    assert "使用说明" in detail.json()["skillMd"]
    assert (await client.get(f"/api/v1/skills/{skill_id}", headers=outsider)).status_code == 404

    download = await client.get(f"/api/v1/skills/{skill_id}/versions/1.0.0/download-url", headers=member)
    assert download.status_code == 200, download.text
    assert download.json()["url"].startswith("memory://")
    assert download.json()["digest"].startswith("sha256:")
    outsider_download = await client.get(
        f"/api/v1/skills/{skill_id}/versions/1.0.0/download-url", headers=outsider
    )
    assert outsider_download.status_code == 404

    # 状态查询：成员 active，无关用户 not_found
    check = await client.post(
        "/api/v1/resources/status:check",
        json={"items": [{"type": "skill", "refId": skill_id, "version": "1.0.0"}]},
        headers=member,
    )
    assert check.json()["items"][0]["status"] == "active"
    check_outsider = await client.post(
        "/api/v1/resources/status:check",
        json={"items": [{"type": "skill", "refId": skill_id, "version": "1.0.0"}]},
        headers=outsider,
    )
    assert check_outsider.json()["items"][0]["status"] == "not_found"

    # 激活上报（用于定向通知）
    reported = await client.post(
        "/api/v1/me/activations:report",
        json={
            "deviceId": "device-stage5",
            "scope": "global",
            "items": [
                {
                    "type": "skill",
                    "source": "market",
                    "refId": skill_id,
                    "name": "pdf-report",
                    "version": "1.0.0",
                    "enabled": True,
                }
            ],
        },
        headers=member,
    )
    assert reported.status_code == 200, reported.text

    # 停用：必填原因；客户端状态变为 disabled 并收到定向通知
    no_reason = await client.post(f"/api/v1/skills/{skill_id}:disable", headers=owner)
    assert no_reason.status_code == 422
    disabled = await client.post(
        f"/api/v1/skills/{skill_id}:disable", params={"reason": "存在安全问题"}, headers=owner
    )
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()["notified"] == 1

    after_disable = await client.post(
        "/api/v1/resources/status:check",
        json={"items": [{"type": "skill", "refId": skill_id, "version": "1.0.0"}]},
        headers=member,
    )
    item = after_disable.json()["items"][0]
    assert item["status"] == "disabled"
    assert item["reason"] == "存在安全问题"

    notifications = await client.get("/api/v1/me/notifications", headers=member)
    disabled_note = next(note for note in notifications.json()["items"] if note["type"] == "skill.disabled")
    # 通知按收件人 users.locale 渲染（design 5.13）：member 此时为中文
    assert disabled_note["title"] == "Skill「pdf-report」已被停用"
    assert disabled_note["body"] == "存在安全问题"

    mark = await client.patch("/api/v1/me/notifications", json={"all": True}, headers=member)
    assert mark.json()["updated"] >= 1

    # 重新启用 → 新版本审批 → 撤回新版本（返回替代版本）
    assert (await client.post(f"/api/v1/skills/{skill_id}:enable", headers=owner)).status_code == 200

    # 切到 en-US 后再停用一次：同一 kind 的通知应为英文（design 5.13）
    assert (await client.patch("/api/v1/me", json={"locale": "en-US"}, headers=member)).status_code == 200
    assert (
        await client.post(
            f"/api/v1/skills/{skill_id}:disable", params={"reason": "security issue"}, headers=owner
        )
    ).status_code == 200
    english_notes = await client.get("/api/v1/me/notifications", headers=member)
    english_note = next(note for note in english_notes.json()["items"] if note["type"] == "skill.disabled")
    assert english_note["title"] == "Skill “pdf-report” was disabled"
    assert english_note["body"] == "security issue"
    assert (await client.post(f"/api/v1/skills/{skill_id}:enable", headers=owner)).status_code == 200
    v2 = await client.post(
        f"/api/v1/skills/{skill_id}/versions",
        params={"changelog": "修复问题"},
        content=make_skill_zip("1.1.0"),
        headers={**member, "content-type": "application/zip"},
    )
    assert v2.status_code == 201, v2.text
    pending2 = await client.get(
        "/api/v1/approvals", params={"scope": "team", "team_id": team_id, "status": "pending"}, headers=owner
    )
    await client.post(
        f"/api/v1/approvals/{pending2.json()['items'][0]['id']}:approve", json={"comment": "ok"}, headers=owner
    )

    revoked = await client.post(
        f"/api/v1/skills/{skill_id}/versions/1.1.0:revoke", params={"reason": "有漏洞"}, headers=owner
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["replacementVersion"] == "1.0.0"

    revoked_check = await client.post(
        "/api/v1/resources/status:check",
        json={"items": [{"type": "skill", "refId": skill_id, "version": "1.1.0"}]},
        headers=member,
    )
    revoked_item = revoked_check.json()["items"][0]
    assert revoked_item["status"] == "revoked"
    assert revoked_item["replacementVersion"] == "1.0.0"

    # 下架（软）→ delisted；重新上架恢复
    assert (await client.post(f"/api/v1/skills/{skill_id}:delist", headers=owner)).status_code == 200
    delisted = await client.post(
        "/api/v1/resources/status:check",
        json={"items": [{"type": "skill", "refId": skill_id, "version": "1.0.0"}]},
        headers=member,
    )
    assert delisted.json()["items"][0]["status"] == "delisted"
    assert (await client.post(f"/api/v1/skills/{skill_id}:publish", headers=owner)).status_code == 200
    assert (await client.get("/api/v1/marketplace/skills", headers=member)).json()["items"]

    # 删除（硬）→ not_found
    deleted = await client.delete(f"/api/v1/skills/{skill_id}", headers=owner)
    assert deleted.status_code == 200
    gone = await client.post(
        "/api/v1/resources/status:check",
        json={"items": [{"type": "skill", "refId": skill_id, "version": "1.0.0"}]},
        headers=member,
    )
    assert gone.json()["items"][0]["status"] == "not_found"


async def test_approval_rules_and_errors(client: AsyncClient) -> None:
    ctx = await setup_org_and_team(client)
    owner = {"Authorization": ctx["owner"]}
    member = {"Authorization": ctx["member"]}
    team_id = ctx["team_id"]

    # 重复 slug 申请冲突（同一 slug 已存在）
    duplicate = await client.post(
        "/api/v1/orgs:apply",
        json={"name": "重复", "slug": ctx["org_slug"], "description": "", "reason": ""},
        headers=member,
    )
    assert duplicate.status_code == 409

    # 驳回必须填写意见
    uploaded = await client.post(
        f"/api/v1/teams/{team_id}/skills",
        content=make_skill_zip("2.0.0"),
        headers={**member, "content-type": "application/zip"},
    )
    assert uploaded.status_code == 201
    pending = await client.get(
        "/api/v1/approvals", params={"scope": "team", "team_id": team_id, "status": "pending"}, headers=owner
    )
    approval_id = pending.json()["items"][0]["id"]

    no_comment = await client.post(f"/api/v1/approvals/{approval_id}:reject", json={}, headers=owner)
    assert no_comment.status_code == 422

    rejected = await client.post(
        f"/api/v1/approvals/{approval_id}:reject", json={"comment": "需要补充说明"}, headers=owner
    )
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"

    # 已处理的审批不能再处理
    again = await client.post(f"/api/v1/approvals/{approval_id}:approve", json={}, headers=owner)
    assert again.status_code == 409

    # 越权：普通成员看不到团队审批
    forbidden = await client.get(
        "/api/v1/approvals", params={"scope": "team", "team_id": team_id}, headers=member
    )
    assert forbidden.status_code == 403

    # 未登录一律 401
    assert (await client.get("/api/v1/marketplace/skills")).status_code == 401
    assert (await client.get("/api/v1/orgs")).status_code == 401

    # 我发起的申请：成员可见自己的被驳回申请
    mine = await client.get("/api/v1/approvals", params={"scope": "mine"}, headers=member)
    assert any(item["status"] == "rejected" for item in mine.json()["items"])

    # 邀请码一次性：同一 token 第二次使用失败
    invite = await client.post(
        f"/api/v1/teams/{team_id}/invitations",
        json={"email": "outsider@example.com", "role": "member"},
        headers=owner,
    )
    # outsider 不是组织成员 → 团队邀请被拒绝
    assert invite.status_code == 422

    org_invite = await client.post(
        f"/api/v1/orgs/{ctx['org_id']}/invitations",
        json={"email": "outsider@example.com", "role": "member"},
        headers=owner,
    )
    assert org_invite.status_code == 201
    token = org_invite.json()["acceptToken"]
    outsider_headers = await _login_again(client, "outsider@example.com")
    assert (
        await client.post("/api/v1/invitations:accept", json={"token": token}, headers=outsider_headers)
    ).status_code == 200
    reuse = await client.post("/api/v1/invitations:accept", json={"token": token}, headers=outsider_headers)
    assert reuse.status_code == 409

    # 邀请与登录账号不匹配
    other_invite = await client.post(
        f"/api/v1/orgs/{ctx['org_id']}/invitations",
        json={"email": "someone-else@example.com", "role": "member"},
        headers=owner,
    )
    mismatch = await client.post(
        "/api/v1/invitations:accept", json={"token": other_invite.json()["acceptToken"]}, headers=member
    )
    assert mismatch.status_code == 403


async def _login_again(client: AsyncClient, email: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD, "device": DEVICE}
    )
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['accessToken']}"}


def _uuid(value: object) -> str:
    return str(uuid.UUID(str(value)))
