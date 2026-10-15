"""邀请接受（design 6.3.4）：一次性 token，7 天有效；未注册用户先注册再接受。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.common.security import hash_refresh_token
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.rbac import require_org_access, require_team_access

router = APIRouter(tags=["invitations"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]


class AcceptIn(ApiModel):
    token: str


class RevokeInvitationIn(ApiModel):
    invitation_id: UUID


class InvitationRevokedOut(ApiModel):
    id: UUID
    status: str


class InvitationPreview(ApiModel):
    type: str
    org_id: str | None
    org_name: str | None
    team_id: str | None
    team_name: str | None
    role: str
    email: str
    expires_at: datetime


SELECT_INVITATION = text(
    """
    SELECT i.id, i.type, i.org_id, o.name AS org_name, i.team_id, t.name AS team_name,
           i.role, i.email, i.status, i.expires_at
    FROM invitations i
    LEFT JOIN orgs o ON o.id = i.org_id
    LEFT JOIN teams t ON t.id = i.team_id
    WHERE i.token_hash = :token_hash
    """
)


SELECT_INVITATION_BY_ID = text(
    "SELECT id, type, org_id, team_id, email, status FROM invitations WHERE id = :id"
)

REVOKE_INVITATION = text(
    "UPDATE invitations SET status = 'revoked' WHERE id = :id AND status = 'pending'"
)


@router.post("/invitations:revoke", response_model=InvitationRevokedOut)
async def revoke_invitation(
    payload: RevokeInvitationIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> InvitationRevokedOut:
    """撤销待处理邀请（design 6.3.4）：组织/团队管理员只能撤销本范围的邀请。"""
    row = (
        await session.execute(SELECT_INVITATION_BY_ID, {"id": payload.invitation_id})
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "邀请不存在")
    if row["status"] != "pending":
        raise AppError(ErrorCode.CONFLICT, "邀请已失效")
    if not actor.is_system_admin:
        if row["type"] == "org":
            await require_org_access(session, actor, row["org_id"], admin=True)
        else:
            await require_team_access(session, actor, row["team_id"], admin=True)

    result = await session.execute(REVOKE_INVITATION, {"id": payload.invitation_id})
    if int(getattr(result, "rowcount", 0) or 0) != 1:
        raise AppError(ErrorCode.CONFLICT, "邀请已失效")
    await record_audit(
        session,
        action=f"invitation.revoke.{row['type']}",
        actor_id=actor.user_id,
        org_id=row["org_id"],
        target_type="invitation",
        target_id=str(row["id"]),
        detail={"email": str(row["email"])},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return InvitationRevokedOut(id=row["id"], status="revoked")


@router.get("/invitations/{token}", response_model=InvitationPreview)
async def preview_invitation(token: str, _: ActorDep, session: SessionDep) -> InvitationPreview:
    row = await _load(session, token)
    return InvitationPreview(
        type=str(row["type"]),
        org_id=str(row["org_id"]) if row["org_id"] else None,
        org_name=row["org_name"],
        team_id=str(row["team_id"]) if row["team_id"] else None,
        team_name=row["team_name"],
        role=str(row["role"]),
        email=str(row["email"]),
        expires_at=row["expires_at"],
    )


@router.post("/invitations:accept")
async def accept_invitation(
    payload: AcceptIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    row = await _load(session, payload.token)
    email = str(row["email"])
    if email.lower() != actor.email.lower():
        raise AppError(ErrorCode.FORBIDDEN, "邀请与当前登录账号不匹配")

    if row["type"] == "org":
        await session.execute(
            text(
                """
                INSERT INTO org_members (org_id, user_id, role) VALUES (:org_id, :user_id, :role)
                ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
                """
            ),
            {"org_id": row["org_id"], "user_id": actor.user_id, "role": row["role"]},
        )
        joined = {"orgId": str(row["org_id"])}
    else:
        # 团队邀请：要求已是组织成员（design 6.3.4）
        org_member = (
            await session.execute(
                text(
                    "SELECT 1 FROM org_members WHERE org_id = :org_id AND user_id = :user_id AND status = 'active'"
                ),
                {"org_id": row["org_id"], "user_id": actor.user_id},
            )
        ).first()
        if org_member is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, "请先加入该组织，再接受团队邀请")
        await session.execute(
            text(
                """
                INSERT INTO team_members (team_id, user_id, role) VALUES (:team_id, :user_id, :role)
                ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'
                """
            ),
            {"team_id": row["team_id"], "user_id": actor.user_id, "role": row["role"]},
        )
        joined = {"teamId": str(row["team_id"])}

    await session.execute(
        text("UPDATE invitations SET status = 'accepted', accepted_at = now(), user_id = :user_id WHERE id = :id"),
        {"id": row["id"], "user_id": actor.user_id},
    )
    await record_audit(
        session,
        action=f"invitation.accept.{row['type']}",
        actor_id=actor.user_id,
        org_id=row["org_id"],
        target_type="invitation",
        target_id=str(row["id"]),
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"type": row["type"], "role": row["role"], **joined}


async def _load(session: AsyncSession, token: str) -> RowMapping:
    row = (
        await session.execute(SELECT_INVITATION, {"token_hash": hash_refresh_token(token)})
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "邀请码无效")
    if row["status"] != "pending":
        raise AppError(ErrorCode.CONFLICT, f"邀请码已{'接受' if row['status'] == 'accepted' else '失效'}")
    if row["expires_at"] <= datetime.now(UTC):
        await session.execute(text("UPDATE invitations SET status = 'expired' WHERE id = :id"), {"id": row["id"]})
        await session.commit()
        raise AppError(ErrorCode.CONFLICT, "邀请码已过期，请管理员重新邀请")
    return row
