"""审计写入（design 6.10.4）：关键操作强制留痕。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

INSERT_AUDIT = text(
    """
    INSERT INTO audit_logs (org_id, actor_id, actor_ip, user_agent, action, target_type, target_id, detail)
    VALUES (:org_id, :actor_id, :actor_ip, :user_agent, :action, :target_type, :target_id, CAST(:detail AS jsonb))
    """
)


async def record_audit(
    session: AsyncSession,
    *,
    action: str,
    actor_id: UUID | None = None,
    org_id: UUID | None = None,
    target_type: str | None = None,
    target_id: str | None = None,
    detail: dict[str, Any] | None = None,
    actor_ip: str | None = None,
    user_agent: str | None = None,
) -> None:
    import json

    await session.execute(
        INSERT_AUDIT,
        {
            "org_id": org_id,
            "actor_id": actor_id,
            "actor_ip": actor_ip,
            "user_agent": user_agent,
            "action": action,
            "target_type": target_type,
            "target_id": target_id,
            "detail": json.dumps(detail or {}, ensure_ascii=False),
        },
    )
