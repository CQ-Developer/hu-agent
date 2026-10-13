"""schema 版本校验（design 6.8.3）：应用启动不执行 DDL，只校验版本。"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.domain.db import get_session_factory


class SchemaVersionError(RuntimeError):
    """数据库 schema 与代码期望不一致。"""


async def applied_versions(session: AsyncSession) -> list[str]:
    result = await session.execute(text("SELECT version FROM schema_versions ORDER BY version"))
    return [str(row[0]) for row in result]


async def verify_schema(expected_version: str) -> None:
    """校验数据库已应用的 schema 版本；不满足则拒绝启动（fail fast）。"""
    async with get_session_factory()() as session:
        exists = (
            await session.execute(text("SELECT to_regclass('public.schema_versions') IS NOT NULL"))
        ).scalar_one()
        if not exists:
            raise SchemaVersionError("数据库未初始化：请先执行 scripts/ddl-apply.sh")
        versions = await applied_versions(session)

    if expected_version not in versions:
        raise SchemaVersionError(f"schema 版本不满足：期望 {expected_version}，实际 {versions or '无'}")
