"""系统设置读取（system_settings，design 6.6.3 / 6.11）。"""

from __future__ import annotations

from typing import Any
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

SELECT_SETTING = text("SELECT value FROM system_settings WHERE key = :key")

UPSERT_SETTING = text(
    """
    INSERT INTO system_settings (key, value, updated_by, updated_at)
    VALUES (:key, CAST(:value AS jsonb), :updated_by, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
    """
)


async def get_setting(session: AsyncSession, key: str, default: Any) -> Any:
    value = (await session.execute(SELECT_SETTING, {"key": key})).scalar_one_or_none()
    if value is None:
        return default
    if isinstance(value, (int, float, str, bool, list, dict)):
        return value
    return default


async def get_int_setting(session: AsyncSession, key: str, default: int) -> int:
    value = await get_setting(session, key, default)
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


async def set_setting(session: AsyncSession, key: str, value: Any, updated_by: UUID | None = None) -> None:
    import json

    await session.execute(
        UPSERT_SETTING,
        {"key": key, "value": json.dumps(value), "updated_by": updated_by},
    )
