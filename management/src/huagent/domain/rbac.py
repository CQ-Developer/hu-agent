"""RBAC 与数据范围断言（design 6.2）。

角色挂在成员关系上（org_members / team_members）；组织管理员对组织内团队有
合规越权（审阅/下架/删除任意团队资源），越权操作写审计。
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor
from huagent.common.errors import AppError, ErrorCode

SELECT_ORG_ACCESS = text(
    """
    SELECT o.id AS org_id, o.status AS org_status, m.role AS org_role
    FROM orgs o
    LEFT JOIN org_members m ON m.org_id = o.id AND m.user_id = :user_id AND m.status = 'active'
    WHERE o.id = :org_id AND o.status <> 'deleted'
    """
)

SELECT_TEAM_ACCESS = text(
    """
    SELECT t.id AS team_id, t.org_id, t.status AS team_status, o.status AS org_status,
           tm.role AS team_role, om.role AS org_role
    FROM teams t
    JOIN orgs o ON o.id = t.org_id
    LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = :user_id AND tm.status = 'active'
    LEFT JOIN org_members om ON om.org_id = t.org_id AND om.user_id = :user_id AND om.status = 'active'
    WHERE t.id = :team_id AND t.status <> 'deleted'
    """
)


@dataclass(frozen=True)
class OrgAccess:
    org_id: UUID
    status: str
    role: str | None

    @property
    def is_member(self) -> bool:
        return self.role is not None

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


@dataclass(frozen=True)
class TeamAccess:
    team_id: UUID
    org_id: UUID
    team_status: str
    org_status: str
    team_role: str | None
    org_role: str | None

    @property
    def is_member(self) -> bool:
        return self.team_role is not None or self.org_role is not None

    @property
    def is_admin(self) -> bool:
        return self.team_role == "admin" or self.org_role == "admin"

    @property
    def via_org_admin(self) -> bool:
        """组织管理员越权访问本组织内的团队资源（design 6.2.1）。"""
        return self.team_role is None and self.org_role == "admin"

    @property
    def org_frozen(self) -> bool:
        return self.org_status != "active"

    @property
    def team_archived(self) -> bool:
        return self.team_status != "active"


async def get_org_access(session: AsyncSession, user_id: UUID, org_id: UUID) -> OrgAccess | None:
    row = (
        await session.execute(SELECT_ORG_ACCESS, {"user_id": user_id, "org_id": org_id})
    ).mappings().first()
    if row is None:
        return None
    return OrgAccess(org_id=row["org_id"], status=str(row["org_status"]), role=row["org_role"])


async def get_team_access(session: AsyncSession, user_id: UUID, team_id: UUID) -> TeamAccess | None:
    row = (
        await session.execute(SELECT_TEAM_ACCESS, {"user_id": user_id, "team_id": team_id})
    ).mappings().first()
    if row is None:
        return None
    return TeamAccess(
        team_id=row["team_id"],
        org_id=row["org_id"],
        team_status=str(row["team_status"]),
        org_status=str(row["org_status"]),
        team_role=row["team_role"],
        org_role=row["org_role"],
    )


async def require_org_access(
    session: AsyncSession,
    actor: Actor,
    org_id: UUID,
    *,
    admin: bool = False,
) -> OrgAccess:
    access = await get_org_access(session, actor.user_id, org_id)
    # 不可见一律 404，避免暴露组织是否存在（design 6.2.3）
    if access is None or not (access.is_member or actor.is_system_admin):
        raise AppError(ErrorCode.NOT_FOUND, "组织不存在或无权访问")
    if admin and not (access.is_admin or actor.is_system_admin):
        raise AppError(ErrorCode.FORBIDDEN, "需要组织管理员权限")
    return access


async def require_team_access(
    session: AsyncSession,
    actor: Actor,
    team_id: UUID,
    *,
    admin: bool = False,
) -> TeamAccess:
    access = await get_team_access(session, actor.user_id, team_id)
    if access is None or not (access.is_member or actor.is_system_admin):
        raise AppError(ErrorCode.NOT_FOUND, "团队不存在或无权访问")
    if admin and not (access.is_admin or actor.is_system_admin):
        raise AppError(ErrorCode.FORBIDDEN, "需要团队管理员权限")
    return access


async def team_ids_for_user(session: AsyncSession, user_id: UUID) -> list[UUID]:
    """用户可见的团队：直接成员 + 所属组织内的团队（组织成员可见团队列表）。"""
    rows = (
        await session.execute(
            text(
                """
                SELECT t.id FROM teams t
                WHERE t.status <> 'deleted' AND (
                  EXISTS (SELECT 1 FROM team_members m
                          WHERE m.team_id = t.id AND m.user_id = :user_id AND m.status = 'active')
                  OR EXISTS (SELECT 1 FROM org_members om
                             WHERE om.org_id = t.org_id AND om.user_id = :user_id AND om.status = 'active')
                )
                """
            ),
            {"user_id": user_id},
        )
    ).scalars().all()
    return [row for row in rows]
