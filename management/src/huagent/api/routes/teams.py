"""团队（design 6.2 / 6.3.3 / 6.3.4 / 6.9.2）。"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.common.security import hash_refresh_token, new_refresh_token
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.notifications import notify, notify_org_admins
from huagent.domain.rbac import TeamAccess, require_org_access, require_team_access

router = APIRouter(tags=["teams"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]


class TeamApplyIn(ApiModel):
    org_id: UUID
    name: str
    description: str = ""
    reason: str = ""


class TeamOut(ApiModel):
    id: UUID
    org_id: UUID
    name: str
    description: str
    status: str
    my_role: str | None
    member_count: int


class TeamMemberOut(ApiModel):
    user_id: UUID
    email: str
    display_name: str
    role: str
    joined_at: datetime


class TeamMembersOut(ApiModel):
    items: list[TeamMemberOut]
    total: int


class MemberPatchIn(ApiModel):
    role: str


class InvitationIn(ApiModel):
    email: str
    role: str = "member"


class InvitationOut(ApiModel):
    id: UUID
    email: str
    role: str
    type: str
    expires_at: datetime
    accept_token: str


SELECT_MY_TEAMS = text(
    """
    SELECT t.id, t.org_id, t.name, t.description, t.status,
           COALESCE(tm.role, om.role) AS my_role,
           (SELECT count(*) FROM team_members x WHERE x.team_id = t.id AND x.status = 'active') AS member_count
    FROM teams t
    JOIN org_members om ON om.org_id = t.org_id AND om.user_id = :user_id AND om.status = 'active'
    LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = :user_id AND tm.status = 'active'
    WHERE t.status <> 'deleted'
    ORDER BY t.created_at
    """
)

SELECT_TEAM = text(
    """
    SELECT t.id, t.org_id, t.name, t.description, t.status,
           COALESCE(tm.role, om.role) AS my_role,
           (SELECT count(*) FROM team_members x WHERE x.team_id = t.id AND x.status = 'active') AS member_count
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = :user_id AND tm.status = 'active'
    LEFT JOIN org_members om ON om.org_id = t.org_id AND om.user_id = :user_id AND om.status = 'active'
    WHERE t.id = :team_id AND t.status <> 'deleted'
    """
)

SELECT_MEMBERS = text(
    """
    SELECT m.user_id, u.email, u.display_name, m.role, m.joined_at
    FROM team_members m JOIN users u ON u.id = m.user_id
    WHERE m.team_id = :team_id AND m.status = 'active'
      AND (:q = '' OR u.email ILIKE '%' || :q || '%' OR u.display_name ILIKE '%' || :q || '%')
    ORDER BY m.joined_at LIMIT :limit OFFSET :offset
    """
)

COUNT_MEMBERS = text("SELECT count(*) FROM team_members WHERE team_id = :team_id AND status = 'active'")
COUNT_TEAM_ADMINS = text(
    "SELECT count(*) FROM team_members WHERE team_id = :team_id AND role = 'admin' AND status = 'active'"
)
SET_MEMBER_ROLE = text(
    "UPDATE team_members SET role = :role WHERE team_id = :team_id AND user_id = :user_id AND status = 'active'"
)
REMOVE_MEMBER = text(
    "UPDATE team_members SET status = 'removed' WHERE team_id = :team_id AND user_id = :user_id AND status = 'active'"
)


@router.post("/teams:apply", status_code=201)
async def apply_team(
    payload: TeamApplyIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    """申请创建团队（design 6.3.3）：由组织管理员审批。"""
    await require_org_access(session, actor, payload.org_id)
    name = payload.name.strip()
    if not 1 <= len(name) <= 60:
        raise AppError(ErrorCode.VALIDATION_FAILED, "团队名称长度需在 1-60 之间")
    duplicate = (
        await session.execute(
            text(
                "SELECT 1 FROM teams WHERE org_id = :org_id AND name = :name AND status <> 'deleted'"
            ),
            {"org_id": payload.org_id, "name": name},
        )
    ).first()
    if duplicate is not None:
        raise AppError(ErrorCode.NAME_CONFLICT, "该组织内已有同名团队")

    row = (
        await session.execute(
            text(
                """
                INSERT INTO approval_requests (type, requester_id, org_id, target_type, target_id, payload)
                VALUES ('team_create', :requester_id, :org_id, 'team_name', :target_id, CAST(:payload AS jsonb))
                RETURNING id, status, created_at
                """
            ),
            {
                "requester_id": actor.user_id,
                "org_id": payload.org_id,
                "target_id": f"{payload.org_id}:{name}",
                "payload": _json({"name": name, "description": payload.description, "reason": payload.reason}),
            },
        )
    ).mappings().one()
    await notify_org_admins(
        session,
        payload.org_id,
        kind="approval.team_create",
        params={"actor": actor.display_name, "name": name},
        payload={"approvalId": str(row["id"])},
    )
    await record_audit(
        session,
        action="team.apply",
        actor_id=actor.user_id,
        org_id=payload.org_id,
        target_type="team_name",
        target_id=name,
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"approvalId": str(row["id"]), "status": row["status"], "createdAt": row["created_at"]}


@router.get("/teams", response_model=list[TeamOut])
async def my_teams(actor: ActorDep, session: SessionDep) -> list[TeamOut]:
    rows = (await session.execute(SELECT_MY_TEAMS, {"user_id": actor.user_id})).mappings().all()
    return [TeamOut(**dict(row)) for row in rows]


@router.get("/teams/{team_id}", response_model=TeamOut)
async def get_team(team_id: UUID, actor: ActorDep, session: SessionDep) -> TeamOut:
    await require_team_access(session, actor, team_id)
    row = (
        await session.execute(SELECT_TEAM, {"team_id": team_id, "user_id": actor.user_id})
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "团队不存在")
    return TeamOut(**dict(row))


@router.get("/teams/{team_id}/members", response_model=TeamMembersOut)
async def list_members(
    team_id: UUID,
    actor: ActorDep,
    session: SessionDep,
    q: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> TeamMembersOut:
    await require_team_access(session, actor, team_id)
    rows = (
        await session.execute(SELECT_MEMBERS, {"team_id": team_id, "q": q, "limit": limit, "offset": offset})
    ).mappings().all()
    total = int((await session.execute(COUNT_MEMBERS, {"team_id": team_id})).scalar_one())
    return TeamMembersOut(items=[TeamMemberOut(**dict(row)) for row in rows], total=total)


@router.post("/teams/{team_id}/invitations", status_code=201, response_model=InvitationOut)
async def invite_to_team(
    team_id: UUID,
    payload: InvitationIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> InvitationOut:
    access = await require_team_access(session, actor, team_id, admin=True)
    if payload.role not in {"admin", "member"}:
        raise AppError(ErrorCode.VALIDATION_FAILED, "role 只能是 admin/member")
    email = payload.email.strip().lower()

    # 团队邀请只允许本组织成员（design 6.3.4）
    org_member = (
        await session.execute(
            text(
                """
                SELECT u.id FROM users u
                JOIN org_members m ON m.user_id = u.id AND m.org_id = :org_id AND m.status = 'active'
                WHERE u.email = :email
                """
            ),
            {"org_id": access.org_id, "email": email},
        )
    ).first()
    if org_member is None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "该用户不是组织成员，请先邀请其加入组织")
    in_team = (
        await session.execute(
            text(
                "SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id "
                "WHERE m.team_id = :team_id AND u.email = :email AND m.status = 'active'"
            ),
            {"team_id": team_id, "email": email},
        )
    ).first()
    if in_team is not None:
        raise AppError(ErrorCode.CONFLICT, "该用户已是团队成员")

    token = new_refresh_token()
    await session.execute(
        text(
            "UPDATE invitations SET status = 'revoked' WHERE type = 'team' AND team_id = :team_id "
            "AND email = :email AND status = 'pending'"
        ),
        {"team_id": team_id, "email": email},
    )
    row = (
        await session.execute(
            text(
                """
                INSERT INTO invitations (type, org_id, team_id, email, role, token_hash, invited_by, expires_at)
                VALUES ('team', :org_id, :team_id, :email, :role, :token_hash, :invited_by, :expires_at)
                RETURNING id, email, role, expires_at
                """
            ),
            {
                "org_id": access.org_id,
                "team_id": team_id,
                "email": email,
                "role": payload.role,
                "token_hash": _hash(token),
                "invited_by": actor.user_id,
                "expires_at": datetime.now(UTC) + timedelta(days=7),
            },
        )
    ).mappings().one()
    user_row = (
        await session.execute(text("SELECT id FROM users WHERE email = :email"), {"email": email})
    ).first()
    if user_row is not None:
        await notify(
            session,
            [user_row[0]],
            kind="team.invitation",
            payload={"teamId": str(team_id), "token": token},
        )
    await record_audit(
        session,
        action="team.member.invite",
        actor_id=actor.user_id,
        org_id=access.org_id,
        target_type="email",
        target_id=email,
        detail={"teamId": str(team_id), "role": payload.role},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return InvitationOut(**dict(row), type="team", accept_token=token)


@router.patch("/teams/{team_id}/members/{user_id}")
async def patch_member(
    team_id: UUID,
    user_id: UUID,
    payload: MemberPatchIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    if payload.role not in {"admin", "member"}:
        raise AppError(ErrorCode.VALIDATION_FAILED, "role 只能是 admin/member")
    access = await require_team_access(session, actor, team_id, admin=True)
    if payload.role == "member":
        await _guard_last_team_admin(session, team_id, user_id, "不能降级最后一个团队管理员")
    result = await session.execute(SET_MEMBER_ROLE, {"team_id": team_id, "user_id": user_id, "role": payload.role})
    if int(getattr(result, "rowcount", 0) or 0) == 0:
        raise AppError(ErrorCode.NOT_FOUND, "成员不存在")
    await _audit_override(session, actor, access, request, "team.member.role", str(user_id), {"role": payload.role})
    await session.commit()
    return {"userId": str(user_id), "role": payload.role}


@router.delete("/teams/{team_id}/members/{user_id}")
async def remove_member(
    team_id: UUID,
    user_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    access = await require_team_access(session, actor, team_id, admin=True)
    await _guard_last_team_admin(session, team_id, user_id, "不能移除最后一个团队管理员")
    result = await session.execute(REMOVE_MEMBER, {"team_id": team_id, "user_id": user_id})
    if int(getattr(result, "rowcount", 0) or 0) == 0:
        raise AppError(ErrorCode.NOT_FOUND, "成员不存在")
    await notify(
        session,
        [user_id],
        kind="team.member.removed",
        payload={"teamId": str(team_id)},
    )
    await _audit_override(session, actor, access, request, "team.member.remove", str(user_id), {})
    await session.commit()
    return {"userId": str(user_id), "removed": True}


async def _guard_last_team_admin(session: AsyncSession, team_id: UUID, user_id: UUID, message: str) -> None:
    is_admin = (
        await session.execute(
            text(
                "SELECT 1 FROM team_members WHERE team_id = :team_id AND user_id = :user_id "
                "AND role = 'admin' AND status = 'active'"
            ),
            {"team_id": team_id, "user_id": user_id},
        )
    ).first()
    if is_admin is None:
        return
    total = int((await session.execute(COUNT_TEAM_ADMINS, {"team_id": team_id})).scalar_one())
    if total <= 1:
        raise AppError(ErrorCode.CONFLICT, message)


async def _audit_override(
    session: AsyncSession,
    actor: Actor,
    access: TeamAccess,
    request: Request,
    action: str,
    target_id: str,
    detail: dict[str, object],
) -> None:
    """组织管理员越权操作团队资源时强制写审计（design 6.2.1）。"""
    await record_audit(
        session,
        action=f"rbac.override.{action}" if access.via_org_admin else action,
        actor_id=actor.user_id,
        org_id=access.org_id,
        target_type="user",
        target_id=target_id,
        detail={**detail, "viaOrgAdmin": access.via_org_admin, "teamId": str(access.team_id)},
        actor_ip=client_ip(request),
    )


def _hash(token: str) -> str:
    return hash_refresh_token(token)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)
