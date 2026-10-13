#!/usr/bin/env python3
"""CI 端到端种子数据：账号、组织/团队/邀请、已发布 Skill、用量事件（幂等）。

供 *.e2e.test.ts 使用（账号与市场资源与测试期望一致）：
- member@example.com / owner@example.com（密码 HUAGENT_E2E_PASSWORD，默认见下）
- 组织 + 团队，member 已是两者成员；一个已发布 Skill（名称含 demo-skill）
- stats-e2e@example.com 的 3 条用量事件（模型 stats-e2e-model，3003/300/1）

运行：`uv run --project management python scripts/ci/seed-e2e.py`
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg

API = os.environ.get("HUAGENT_API", "http://127.0.0.1:8080")
PASSWORD = os.environ.get("HUAGENT_E2E_PASSWORD", "Str0ng-Passphrase-2026")
DEVICE = {"deviceId": "ci-seed", "platform": "linux", "appVersion": "0.1.0"}
SKILL_MD = """---
name: demo-skill-ci
description: CI 端到端测试用 Skill
version: 1.0.0
when_to_use: 仅在自动化测试中使用
requires:
  tools: [read_file]
  bins: []
  network: false
tags: [demo]
min_app_version: 0.1.0
---

# CI 演示 Skill

由 scripts/ci/seed-e2e.py 生成。
"""


def call(path: str, *, token: str | None = None, method: str = "GET", body: Any = None) -> tuple[int, Any]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{API}{path}", data=data, method=method)  # noqa: S310
    request.add_header("content-type", "application/json")
    request.add_header("x-client-version", "0.1.0")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        payload = error.read().decode()
        try:
            return error.code, json.loads(payload or "{}")
        except json.JSONDecodeError:
            return error.code, {"raw": payload[:200]}


def login(email: str) -> str:
    status, body = call(
        "/api/v1/auth/register",
        method="POST",
        body={"email": email, "password": PASSWORD, "displayName": email.split("@")[0]},
    )
    assert status in (201, 409), body
    status, body = call(
        "/api/v1/auth/login", method="POST", body={"email": email, "password": PASSWORD, "device": DEVICE}
    )
    assert status == 200, body
    return str(body["accessToken"])


def approve(token: str, approval_id: str) -> None:
    status, body = call(
        f"/api/v1/approvals/{approval_id}:approve", token=token, method="POST", body={"comment": "CI 自动通过"}
    )
    assert status == 200, body


def skill_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("SKILL.md", SKILL_MD)
        archive.writestr("scripts/run.sh", "#!/bin/sh\necho ci\n")
    return buffer.getvalue()


def upload_skill(team_id: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(  # noqa: S310
        f"{API}/api/v1/teams/{team_id}/skills?changelog=ci", data=skill_zip(), method="POST"
    )
    request.add_header("content-type", "application/zip")
    request.add_header("x-client-version", "0.1.0")
    request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
            return {"status": response.status, "body": json.loads(response.read().decode())}
    except urllib.error.HTTPError as error:
        return {"status": error.code, "body": json.loads(error.read().decode() or "{}")}


def main() -> int:
    database_url = os.environ.get(
        "HUAGENT_DATABASE_URL", "postgresql://huagent:huagent_dev@localhost:5432/huagent"
    ).replace("postgresql+psycopg://", "postgresql://")

    sysadmin = login("sysadmin@example.com")
    owner = login("owner@example.com")
    member = login("member@example.com")
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE users SET is_system_admin = true WHERE email = 'sysadmin@example.com'")
    print("[seed] 账号就绪")

    suffix = uuid.uuid4().hex[:6]
    status, applied = call(
        "/api/v1/orgs:apply",
        token=owner,
        method="POST",
        body={"name": f"CI 组织 {suffix}", "slug": f"ci-org-{suffix}", "description": "CI", "reason": "CI"},
    )
    assert status == 201, applied
    approve(sysadmin, applied["approvalId"])
    _, orgs = call("/api/v1/orgs", token=owner)
    org = next(item for item in orgs if item["slug"] == f"ci-org-{suffix}")

    status, team_applied = call(
        "/api/v1/teams:apply",
        token=owner,
        method="POST",
        body={"orgId": org["id"], "name": f"CI 团队 {suffix}", "description": "CI", "reason": "CI"},
    )
    assert status == 201, team_applied
    approve(owner, team_applied["approvalId"])
    _, teams = call("/api/v1/teams", token=owner)
    team = next(item for item in teams if item["name"] == f"CI 团队 {suffix}")

    status, org_invite = call(
        f"/api/v1/orgs/{org['id']}/invitations",
        token=owner,
        method="POST",
        body={"email": "member@example.com", "role": "member"},
    )
    assert status == 201, org_invite
    status, body = call(
        "/api/v1/invitations:accept", token=member, method="POST", body={"token": org_invite["acceptToken"]}
    )
    assert status in (200, 409), body
    status, team_invite = call(
        f"/api/v1/teams/{team['id']}/invitations",
        token=owner,
        method="POST",
        body={"email": "member@example.com", "role": "member"},
    )
    assert status == 201, team_invite
    status, body = call(
        "/api/v1/invitations:accept", token=member, method="POST", body={"token": team_invite["acceptToken"]}
    )
    assert status in (200, 409), body
    print(f"[seed] 组织/团队/成员就绪 org={org['id']} team={team['id']}")

    uploaded = upload_skill(team["id"], member)
    assert uploaded["status"] == 201, uploaded
    version = uploaded["body"]
    _, pending = call(f"/api/v1/approvals?scope=team&team_id={team['id']}&status=pending", token=owner)
    approval = next(item for item in pending["items"] if item["targetId"] == version["versionId"])
    approve(owner, approval["id"])
    print(f"[seed] Skill 已发布 skillId={version['skillId']} version={version['version']}")

    stats_token = login("stats-e2e@example.com")
    occurred = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=3)
    events = [
        {
            "eventId": str(uuid.uuid4()),
            "occurredAt": occurred.isoformat(),
            "deviceId": "ci-seed",
            "provider": "deepseek",
            "model": "stats-e2e-model",
            "inputTokens": 1000,
            "outputTokens": 100,
            "requests": 1,
            "status": "success",
        },
        {
            "eventId": str(uuid.uuid4()),
            "occurredAt": occurred.isoformat(),
            "deviceId": "ci-seed",
            "provider": "deepseek",
            "model": "stats-e2e-model",
            "inputTokens": 2001,
            "outputTokens": 200,
            "requests": 1,
            "status": "success",
        },
        {
            "eventId": str(uuid.uuid4()),
            "occurredAt": occurred.isoformat(),
            "deviceId": "ci-seed",
            "provider": "deepseek",
            "model": "stats-e2e-model",
            "inputTokens": 2,
            "outputTokens": 0,
            "requests": 1,
            "status": "error",
        },
    ]
    status, body = call("/api/v1/usage:batch", token=stats_token, method="POST", body={"events": events})
    assert status == 200 and body["accepted"] == 3, body
    print("[seed] 用量事件已上报（等待聚合任务）")

    print(
        "[seed] 完成",
        json.dumps({"orgId": org["id"], "teamId": team["id"], "skillId": version["skillId"], "version": version["version"]}),
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
