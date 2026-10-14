"""站内通知（design 6.3.1 / 6.4.5 / 5.13）。

通知按收件人 `users.locale` 在写入时渲染（见 `domain/messages.py`）；
调用方只提供 `kind` 与参数，不再拼中文文案。
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.domain.messages import render_notification

INSERT_NOTIFICATION = text(
    """
    INSERT INTO notifications (user_id, type, title, body, payload)
    VALUES (:user_id, :type, :title, :body, CAST(:payload AS jsonb))
    """
)

SELECT_LOCALES = text("SELECT id, locale FROM users WHERE id = ANY(CAST(:ids AS uuid[]))")


async def notify(
    session: AsyncSession,
    user_ids: Iterable[UUID],
    *,
    kind: str,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
) -> int:
    """按收件人语言渲染并批量写入站内通知；返回写入条数。调用方负责事务提交。"""
    unique = {user_id for user_id in user_ids}
    if not unique:
        return 0
    locales = {
        row["id"]: row["locale"]
        for row in (await session.execute(SELECT_LOCALES, {"ids": list(unique)})).mappings().all()
    }
    merged_payload = {**(payload or {}), "kind": kind}
    for user_id in unique:
        title, body = render_notification(kind, locales.get(user_id), params or {})
        await session.execute(
            INSERT_NOTIFICATION,
            {
                "user_id": user_id,
                "type": kind,
                "title": title,
                "body": body,
                "payload": json.dumps(merged_payload, ensure_ascii=False),
            },
        )
    return len(unique)


async def notify_team_admins(
    session: AsyncSession,
    team_id: UUID,
    *,
    kind: str,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
) -> int:
    rows = (
        await session.execute(
            text(
                "SELECT user_id FROM team_members WHERE team_id = :team_id AND role = 'admin' AND status = 'active'"
            ),
            {"team_id": team_id},
        )
    ).scalars().all()
    return await notify(session, rows, kind=kind, params=params, payload=payload)


async def notify_org_admins(
    session: AsyncSession,
    org_id: UUID,
    *,
    kind: str,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
) -> int:
    rows = (
        await session.execute(
            text(
                "SELECT user_id FROM org_members WHERE org_id = :org_id AND role = 'admin' AND status = 'active'"
            ),
            {"org_id": org_id},
        )
    ).scalars().all()
    return await notify(session, rows, kind=kind, params=params, payload=payload)


async def notify_activation_users(
    session: AsyncSession,
    *,
    resource_type: str,
    ref_id: UUID,
    kind: str,
    params: dict[str, Any] | None = None,
    payload: dict[str, Any] | None = None,
) -> int:
    """向曾启用该资源的用户发定向通知（design 6.4.5）。"""
    rows = (
        await session.execute(
            text(
                """
                SELECT DISTINCT user_id FROM activation_reports
                WHERE resource_type = :resource_type AND ref_id = :ref_id AND enabled = true
                """
            ),
            {"resource_type": resource_type, "ref_id": ref_id},
        )
    ).scalars().all()
    return await notify(session, rows, kind=kind, params=params, payload=payload)
