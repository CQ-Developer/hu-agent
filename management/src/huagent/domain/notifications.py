"""站内通知（design 6.3.1 / 6.4.5）。"""

from __future__ import annotations

import json
from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

INSERT_NOTIFICATION = text(
    """
    INSERT INTO notifications (user_id, type, title, body, payload)
    VALUES (:user_id, :type, :title, :body, CAST(:payload AS jsonb))
    """
)


async def notify(
    session: AsyncSession,
    user_ids: Iterable[UUID],
    *,
    type: str,
    title: str,
    body: str = "",
    payload: dict[str, Any] | None = None,
) -> int:
    """批量写入站内通知；返回写入条数。调用方负责事务提交。"""
    unique = {user_id for user_id in user_ids}
    for user_id in unique:
        await session.execute(
            INSERT_NOTIFICATION,
            {
                "user_id": user_id,
                "type": type,
                "title": title,
                "body": body,
                "payload": json.dumps(payload or {}, ensure_ascii=False),
            },
        )
    return len(unique)


async def notify_team_admins(
    session: AsyncSession,
    team_id: UUID,
    *,
    type: str,
    title: str,
    body: str = "",
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
    return await notify(session, rows, type=type, title=title, body=body, payload=payload)


async def notify_org_admins(
    session: AsyncSession,
    org_id: UUID,
    *,
    type: str,
    title: str,
    body: str = "",
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
    return await notify(session, rows, type=type, title=title, body=body, payload=payload)


async def notify_activation_users(
    session: AsyncSession,
    *,
    resource_type: str,
    ref_id: UUID,
    type: str,
    title: str,
    body: str,
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
    return await notify(session, rows, type=type, title=title, body=body, payload=payload)
