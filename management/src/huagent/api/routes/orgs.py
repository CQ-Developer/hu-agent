"""组织（design 6.2 / 6.3.1-6.3.4 / 6.9.2）。"""

from __future__ import annotations

import json
import re
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
from huagent.domain.notifications import notify
from huagent.domain.rbac import require_org_access

router = APIRouter(tags=["orgs"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]


class OrgApplyIn(ApiModel):
    name: str
    slug: str
    description: str = ""
    reason: str = ""


class OrgPatchIn(ApiModel):
    name: str | None = None
    description: str | None = None


class OrgOut(ApiModel):
    id: UUID
    name: str
    slug: str
    description: str
    status: str
    role: str | None
    member_count: int = 0
    team_count: int = 0


class OrgMemberOut(ApiModel):
    user_id: UUID
    email: str
    display_name: str
    role: str
    status: str
    joined_at: datetime


class OrgMembersOut(ApiModel):
    items: list[OrgMemberOut]
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
    accepted: bool
    accept_token: str | None = None


class PendingInvitationOut(ApiModel):
    id: UUID
    email: str
    role: str
    status: str
    expires_at: datetime
    created_at: datetime
    invited_by_email: str | None


class TeamBriefOut(ApiModel):
    id: UUID
    name: str
    description: str
    status: str
    role: str | None


class OrgTeamsOut(ApiModel):
    items: list[TeamBriefOut]


SELECT_MY_ORGS = text(
    """
    SELECT o.id, o.name, o.slug, o.description, o.status, m.role,
           (SELECT count(*) FROM org_members x WHERE x.org_id = o.id AND x.status = 'active') AS member_count,
           (SELECT count(*) FROM teams t WHERE t.org_id = o.id AND t.status = 'active') AS team_count
    FROM orgs o
    JOIN org_members m ON m.org_id = o.id AND m.user_id = :user_id AND m.status = 'active'
    WHERE o.status <> 'deleted'
    ORDER BY o.created_at
    """
)

INSERT_ORG = text(
    """
    INSERT INTO orgs (name, slug, description, created_by)
    VALUES (:name, :slug, :description, :created_by)
    RETURNING id, name, slug, description, status
    """
)

INSERT_ORG_MEMBER = text(
    """
    INSERT INTO org_members (org_id, user_id, role) VALUES (:org_id, :user_id, :role)
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
    """
)

SELECT_ORG = text("SELECT id, name, slug, description, status FROM orgs WHERE id = :org_id AND status <> 'deleted'")

UPDATE_ORG = text(
    """
    UPDATE orgs SET name = COALESCE(:name, name), description = COALESCE(:description, description)
    WHERE id = :org_id RETURNING id, name, slug, description, status
    """
)

SELECT_MEMBERS = text(
    """
    SELECT m.user_id, u.email, u.display_name, m.role, m.status, m.joined_at
    FROM org_members m JOIN users u ON u.id = m.user_id
    WHERE m.org_id = :org_id AND m.status = 'active'
      AND (:q = '' OR u.email ILIKE '%' || :q || '%' OR u.display_name ILIKE '%' || :q || '%')
    ORDER BY m.joined_at
    LIMIT :limit OFFSET :offset
    """
)

COUNT_MEMBERS = text("SELECT count(*) FROM org_members WHERE org_id = :org_id AND status = 'active'")

COUNT_ORG_ADMINS = text(
    "SELECT count(*) FROM org_members WHERE org_id = :org_id AND role = 'admin' AND status = 'active'"
)

SET_MEMBER_ROLE = text(
    "UPDATE org_members SET role = :role WHERE org_id = :org_id AND user_id = :user_id AND status = 'active'"
)

REMOVE_MEMBER = text(
    "UPDATE org_members SET status = 'removed' WHERE org_id = :org_id AND user_id = :user_id AND status = 'active'"
)

REVOKE_PENDING_INVITATIONS = text(
    """
    UPDATE invitations SET status = 'revoked'
    WHERE type = 'org' AND org_id = :org_id AND email = :email AND status = 'pending'
    """
)

INSERT_INVITATION = text(
    """
    INSERT INTO invitations (type, org_id, email, role, token_hash, invited_by, expires_at)
    VALUES ('org', :org_id, :email, :role, :token_hash, :invited_by, :expires_at)
    RETURNING id, email, role, expires_at
    """
)

SELECT_ORG_TEAMS = text(
    """
    SELECT t.id, t.name, t.description, t.status,
           (SELECT role FROM team_members m
            WHERE m.team_id = t.id AND m.user_id = :user_id AND m.status = 'active') AS role
    FROM teams t WHERE t.org_id = :org_id AND t.status <> 'deleted' ORDER BY t.created_at
    """
)

SELECT_ORG_OWNER_EMAIL = text("SELECT email FROM users WHERE id = :user_id")


@router.post("/orgs:apply", status_code=201)
async def apply_org(payload: OrgApplyIn, actor: ActorDep, request: Request, session: SessionDep) -> dict[str, object]:
    """申请创建组织（design 6.3.2）：生成 approval_request，等系统管理员审批。"""
    name = payload.name.strip()
    slug = payload.slug.strip().lower()
    if not 1 <= len(name) <= 60:
        raise AppError(ErrorCode.VALIDATION_FAILED, "组织名称长度需在 1-60 之间")
    if not re_slug(slug):
        raise AppError(ErrorCode.VALIDATION_FAILED, "slug 需为小写字母/数字/连字符（2-60 位）")

    existing = (
        await session.execute(text("SELECT 1 FROM orgs WHERE slug = :slug AND status <> 'deleted'"), {"slug": slug})
    ).first()
    if existing is not None:
        raise AppError(ErrorCode.NAME_CONFLICT, "该 slug 已被使用")

    pending = (
        await session.execute(
            text(
                "SELECT 1 FROM approval_requests WHERE type = 'org_create' AND status = 'pending' AND target_id = :slug"
            ),
            {"slug": slug},
        )
    ).first()
    if pending is not None:
        raise AppError(ErrorCode.CONFLICT, "该 slug 已有待审批的申请")

    row = (
        await session.execute(
            text(
                """
                INSERT INTO approval_requests (type, requester_id, target_type, target_id, payload)
                VALUES ('org_create', :requester_id, 'org_slug', :slug, CAST(:payload AS jsonb))
                RETURNING id, status, created_at
                """
            ),
            {
                "requester_id": actor.user_id,
                "slug": slug,
                "payload": json.dumps(
                    {"name": name, "slug": slug, "description": payload.description, "reason": payload.reason},
                    ensure_ascii=False,
                ),
            },
        )
    ).mappings().one()

    admins = (
        await session.execute(text("SELECT id FROM users WHERE is_system_admin AND status = 'active'"))
    ).scalars().all()
    await notify(
        session,
        admins,
        kind="approval.org_create",
        params={"actor": actor.display_name, "name": name},
        payload={"approvalId": str(row["id"])},
    )
    await record_audit(
        session,
        action="org.apply",
        actor_id=actor.user_id,
        target_type="org_slug",
        target_id=slug,
        detail={"name": name},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"approvalId": str(row["id"]), "status": row["status"], "createdAt": row["created_at"]}


@router.get("/orgs", response_model=list[OrgOut])
async def my_orgs(actor: ActorDep, session: SessionDep) -> list[OrgOut]:
    rows = (await session.execute(SELECT_MY_ORGS, {"user_id": actor.user_id})).mappings().all()
    return [OrgOut(**dict(row)) for row in rows]


@router.get("/orgs/{org_id}", response_model=OrgOut)
async def get_org(org_id: UUID, actor: ActorDep, session: SessionDep) -> OrgOut:
    await require_org_access(session, actor, org_id)
    row = (await session.execute(SELECT_ORG, {"org_id": org_id})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "组织不存在")
    member_count = (
        await session.execute(COUNT_MEMBERS, {"org_id": org_id})
    ).scalar_one()
    return OrgOut(**dict(row), member_count=int(member_count))


@router.patch("/orgs/{org_id}", response_model=OrgOut)
async def patch_org(org_id: UUID, payload: OrgPatchIn, actor: ActorDep, session: SessionDep) -> OrgOut:
    await require_org_access(session, actor, org_id, admin=True)
    row = (
        await session.execute(
            UPDATE_ORG,
            {"org_id": org_id, "name": payload.name, "description": payload.description},
        )
    ).mappings().one()
    await session.commit()
    return OrgOut(**dict(row))


@router.get("/orgs/{org_id}/members", response_model=OrgMembersOut)
async def list_org_members(
    org_id: UUID,
    actor: ActorDep,
    session: SessionDep,
    q: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> OrgMembersOut:
    await require_org_access(session, actor, org_id)
    rows = (
        await session.execute(SELECT_MEMBERS, {"org_id": org_id, "q": q, "limit": limit, "offset": offset})
    ).mappings().all()
    total = int((await session.execute(COUNT_MEMBERS, {"org_id": org_id})).scalar_one())
    return OrgMembersOut(items=[OrgMemberOut(**dict(row)) for row in rows], total=total)


@router.patch("/orgs/{org_id}/members/{user_id}")
async def patch_org_member(
    org_id: UUID,
    user_id: UUID,
    payload: MemberPatchIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    if payload.role not in {"admin", "member"}:
        raise AppError(ErrorCode.VALIDATION_FAILED, "role 只能是 admin/member")
    await require_org_access(session, actor, org_id, admin=True)
    if payload.role == "member":
        await _guard_last_org_admin(session, org_id, user_id, "不能降级最后一个组织管理员")
    result = await session.execute(
        SET_MEMBER_ROLE, {"org_id": org_id, "user_id": user_id, "role": payload.role}
    )
    if int(getattr(result, "rowcount", 0) or 0) == 0:
        raise AppError(ErrorCode.NOT_FOUND, "成员不存在")
    await record_audit(
        session,
        action="org.member.role",
        actor_id=actor.user_id,
        org_id=org_id,
        target_type="user",
        target_id=str(user_id),
        detail={"role": payload.role},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"userId": str(user_id), "role": payload.role}


@router.delete("/orgs/{org_id}/members/{user_id}")
async def remove_org_member(
    org_id: UUID,
    user_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    await require_org_access(session, actor, org_id, admin=True)
    await _guard_last_org_admin(session, org_id, user_id, "不能移除最后一个组织管理员")
    # 同步移除该组织下所有团队的成员关系（design 6.2.1：团队归属组织）
    await session.execute(
        text(
            """
            UPDATE team_members SET status = 'removed'
            WHERE user_id = :user_id AND status = 'active'
              AND team_id IN (SELECT id FROM teams WHERE org_id = :org_id)
            """
        ),
        {"org_id": org_id, "user_id": user_id},
    )
    result = await session.execute(REMOVE_MEMBER, {"org_id": org_id, "user_id": user_id})
    if int(getattr(result, "rowcount", 0) or 0) == 0:
        raise AppError(ErrorCode.NOT_FOUND, "成员不存在")
    await notify(
        session,
        [user_id],
        kind="org.member.removed",
        payload={"orgId": str(org_id)},
    )
    await record_audit(
        session,
        action="org.member.remove",
        actor_id=actor.user_id,
        org_id=org_id,
        target_type="user",
        target_id=str(user_id),
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"userId": str(user_id), "removed": True}


@router.post("/orgs/{org_id}/invitations", status_code=201, response_model=InvitationOut)
async def invite_to_org(
    org_id: UUID,
    payload: InvitationIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> InvitationOut:
    await require_org_access(session, actor, org_id, admin=True)
    return await _create_org_invitation(session, actor, org_id, payload, request)


SELECT_PENDING_ORG_INVITATIONS = text(
    """
    SELECT i.id, i.email, i.role, i.status, i.expires_at, i.created_at,
           u.email AS invited_by_email
    FROM invitations i
    LEFT JOIN users u ON u.id = i.invited_by
    WHERE i.org_id = :org_id AND i.status = 'pending' AND i.expires_at > now()
    ORDER BY i.created_at DESC
    """
)


@router.get("/orgs/{org_id}/invitations", response_model=list[PendingInvitationOut])
async def list_org_invitations(
    org_id: UUID,
    actor: ActorDep,
    session: SessionDep,
) -> list[PendingInvitationOut]:
    """待处理邀请（design 6.3.4）：仅组织管理员可见，用于撤销。"""
    await require_org_access(session, actor, org_id, admin=True)
    rows = (
        await session.execute(SELECT_PENDING_ORG_INVITATIONS, {"org_id": org_id})
    ).mappings().all()
    return [PendingInvitationOut(**dict(row)) for row in rows]


@router.get("/orgs/{org_id}/teams", response_model=OrgTeamsOut)
async def list_org_teams(org_id: UUID, actor: ActorDep, session: SessionDep) -> OrgTeamsOut:
    await require_org_access(session, actor, org_id)
    rows = (
        await session.execute(SELECT_ORG_TEAMS, {"org_id": org_id, "user_id": actor.user_id})
    ).mappings().all()
    return OrgTeamsOut(items=[TeamBriefOut(**dict(row)) for row in rows])


async def _create_org_invitation(
    session: AsyncSession,
    actor: Actor,
    org_id: UUID,
    payload: InvitationIn,
    request: Request,
) -> InvitationOut:
    if payload.role not in {"admin", "member"}:
        raise AppError(ErrorCode.VALIDATION_FAILED, "role 只能是 admin/member")
    email = payload.email.strip().lower()
    if "@" not in email:
        raise AppError(ErrorCode.VALIDATION_FAILED, "邮箱格式不正确")
    existing = (
        await session.execute(
            text(
                """
                SELECT 1 FROM org_members m JOIN users u ON u.id = m.user_id
                WHERE m.org_id = :org_id AND u.email = :email AND m.status = 'active'
                """
            ),
            {"org_id": org_id, "email": email},
        )
    ).first()
    if existing is not None:
        raise AppError(ErrorCode.CONFLICT, "该用户已是组织成员")

    token = new_refresh_token()
    await session.execute(REVOKE_PENDING_INVITATIONS, {"org_id": org_id, "email": email})
    row = (
        await session.execute(
            INSERT_INVITATION,
            {
                "org_id": org_id,
                "email": email,
                "role": payload.role,
                "token_hash": hash_invitation(token),
                "invited_by": actor.user_id,
                "expires_at": datetime.now(UTC) + timedelta(days=7),
            },
        )
    ).mappings().one()
    await notify(
        session,
        await _user_ids_by_email(session, email),
        kind="org.invitation",
        payload={"orgId": str(org_id), "token": token},
    )
    await record_audit(
        session,
        action="org.member.invite",
        actor_id=actor.user_id,
        org_id=org_id,
        target_type="email",
        target_id=email,
        detail={"role": payload.role},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return InvitationOut(**dict(row), type="org", accepted=False, accept_token=token)


async def _guard_last_org_admin(session: AsyncSession, org_id: UUID, user_id: UUID, message: str) -> None:
    is_admin = (
        await session.execute(
            text(
                "SELECT 1 FROM org_members WHERE org_id = :org_id AND user_id = :user_id "
                "AND role = 'admin' AND status = 'active'"
            ),
            {"org_id": org_id, "user_id": user_id},
        )
    ).first()
    if is_admin is None:
        return
    total = int((await session.execute(COUNT_ORG_ADMINS, {"org_id": org_id})).scalar_one())
    if total <= 1:
        raise AppError(ErrorCode.CONFLICT, message)


async def _user_ids_by_email(session: AsyncSession, email: str) -> list[UUID]:
    return list(
        (await session.execute(text("SELECT id FROM users WHERE email = :email"), {"email": email})).scalars().all()
    )


def hash_invitation(token: str) -> str:
    return hash_refresh_token(token)


def re_slug(value: str) -> bool:
    return bool(re.match(r"^[a-z0-9][a-z0-9-]{1,59}$", value))
