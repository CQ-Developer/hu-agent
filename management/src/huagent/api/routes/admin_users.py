"""系统区用户管理（design 7.2 / 6.10.1）：列表、禁用/启用、强制下线、宽限期恢复、重置密码。

仅系统管理员可访问；所有写操作写审计（`admin.user.*`），禁用与恢复额外发站内通知。
重置密码只签发一次性令牌（24 小时、库中仅存哈希），用户在管理台公开页
`/reset-password?token=...` 自行设置新密码（`POST /auth/password/reset`），
与 CLI 的「生成一次性口令」机制并存且互不影响。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor, require_system_admin
from huagent.api.schemas import ApiModel
from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.common.security import hash_refresh_token, new_refresh_token
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.notifications import notify
from huagent.domain.settings import get_int_setting

router = APIRouter(prefix="/admin", tags=["admin-users"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]

#: 管理员签发的重置令牌有效期（design 6.10.1）
RESET_TOKEN_TTL_HOURS = 24

#: 列表筛选：禁用与「注销宽限期」分开，避免把等待清理的账号误当成普通禁用
UserStatusFilter = Literal["active", "disabled", "pending_deletion"]


class AdminUserOut(ApiModel):
    id: UUID
    email: str
    display_name: str
    status: str
    is_system_admin: bool
    locale: str
    created_at: datetime
    deletion_requested_at: datetime | None
    #: 宽限期结束时间（deletion_requested_at + account.deletion_grace_days）
    purge_at: datetime | None
    purged_at: datetime | None
    #: 本地密码是否已设置（SSO-only 账号为 false）
    has_password: bool


class AdminUserListOut(ApiModel):
    items: list[AdminUserOut]
    total: int


class UserActionOut(ApiModel):
    id: UUID
    status: str


class UserDisableIn(ApiModel):
    reason: str | None = None


class ResetPasswordOut(ApiModel):
    token: str
    expires_at: datetime


#: 列表与计数的 WHERE 保持同一份条件（写两遍是为了静态 SQL：动态拼接会被 bandit B608 标记）
SELECT_USERS = text(
    """
    SELECT id, email, display_name, status, is_system_admin, locale, created_at,
           deletion_requested_at, purged_at, (password_hash IS NOT NULL) AS has_password,
           CASE WHEN deletion_requested_at IS NULL THEN NULL
                ELSE deletion_requested_at + make_interval(days => :grace_days) END AS purge_at
    FROM users
    WHERE (:q = '' OR email::text ILIKE :pattern OR display_name ILIKE :pattern)
      AND (
        CAST(:status AS text) IS NULL
        OR (:status = 'active' AND status = 'active' AND deletion_requested_at IS NULL)
        OR (:status = 'disabled' AND status = 'disabled' AND deletion_requested_at IS NULL)
        OR (:status = 'pending_deletion' AND deletion_requested_at IS NOT NULL AND purged_at IS NULL)
      )
    ORDER BY created_at DESC
    LIMIT :limit OFFSET :offset
    """
)

COUNT_USERS = text(
    """
    SELECT count(*) FROM users
    WHERE (:q = '' OR email::text ILIKE :pattern OR display_name ILIKE :pattern)
      AND (
        CAST(:status AS text) IS NULL
        OR (:status = 'active' AND status = 'active' AND deletion_requested_at IS NULL)
        OR (:status = 'disabled' AND status = 'disabled' AND deletion_requested_at IS NULL)
        OR (:status = 'pending_deletion' AND deletion_requested_at IS NOT NULL AND purged_at IS NULL)
      )
    """
)

SELECT_TARGET = text(
    """
    SELECT id, email, status, is_system_admin, deletion_requested_at, purged_at
    FROM users WHERE id = :user_id
    """
)

REVOKE_ALL_TOKENS = text(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :user_id AND revoked_at IS NULL"
)
SET_DISABLED = text("UPDATE users SET status = 'disabled', updated_at = now() WHERE id = :user_id")
SET_ACTIVE = text("UPDATE users SET status = 'active', updated_at = now() WHERE id = :user_id")
RESTORE_USER = text(
    """
    UPDATE users
    SET status = 'active', deletion_requested_at = NULL, updated_at = now()
    WHERE id = :user_id
    """
)
DELETE_UNUSED_RESET_TOKENS = text(
    "DELETE FROM password_reset_tokens WHERE user_id = :user_id AND used_at IS NULL"
)
INSERT_RESET_TOKEN = text(
    """
    INSERT INTO password_reset_tokens (user_id, token_hash, issued_by, expires_at)
    VALUES (:user_id, :token_hash, :issued_by, :expires_at)
    RETURNING expires_at
    """
)


async def _load_target(session: AsyncSession, user_id: UUID) -> RowMapping:
    row = (await session.execute(SELECT_TARGET, {"user_id": user_id})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "用户不存在")
    return row


def _ensure_not_purged(row: RowMapping) -> None:
    if row["purged_at"] is not None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "账号已完成注销清理，无法恢复")


@router.get("/users", response_model=AdminUserListOut)
async def list_users(
    actor: ActorDep,
    session: SessionDep,
    q: str = Query(default="", max_length=100),
    status: Annotated[UserStatusFilter | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AdminUserListOut:
    require_system_admin(actor)
    grace_days = await get_int_setting(
        session, "account.deletion_grace_days", get_settings().account_deletion_grace_days
    )
    params = {
        "q": q.strip(),
        "pattern": f"%{q.strip()}%",
        "status": status,
        "grace_days": grace_days,
        "limit": limit,
        "offset": offset,
    }
    rows = (await session.execute(SELECT_USERS, params)).mappings().all()
    total = int((await session.execute(COUNT_USERS, params)).scalar_one())
    return AdminUserListOut(items=[AdminUserOut(**dict(row)) for row in rows], total=total)


@router.post("/users/{user_id}:disable", response_model=UserActionOut)
async def disable_user(
    user_id: UUID,
    payload: UserDisableIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> UserActionOut:
    """禁用账号：撤销全部会话；已是禁用状态时幂等返回（不重复通知/审计）。"""
    require_system_admin(actor)
    target = await _load_target(session, user_id)
    _ensure_not_purged(target)
    if target["id"] == actor.user_id:
        raise AppError(ErrorCode.VALIDATION_FAILED, "不能禁用当前登录的账号")

    revoked = await session.execute(REVOKE_ALL_TOKENS, {"user_id": user_id})
    changed = target["status"] != "disabled"
    if changed:
        await session.execute(SET_DISABLED, {"user_id": user_id})
        await notify(session, [user_id], kind="user.disabled", params={"reason": payload.reason})
        await record_audit(
            session,
            action="admin.user.disable",
            actor_id=actor.user_id,
            target_type="user",
            target_id=str(user_id),
            detail={
                "email": str(target["email"]),
                "reason": payload.reason,
                "revokedTokens": int(getattr(revoked, "rowcount", 0) or 0),
            },
            actor_ip=client_ip(request),
        )
    await session.commit()
    return UserActionOut(id=user_id, status="disabled")


@router.post("/users/{user_id}:enable", response_model=UserActionOut)
async def enable_user(
    user_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> UserActionOut:
    """启用被禁用的账号；注销宽限期内的账号必须走 `:restore`，避免误清注销意图。"""
    require_system_admin(actor)
    target = await _load_target(session, user_id)
    _ensure_not_purged(target)
    if target["deletion_requested_at"] is not None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "账号处于注销宽限期，请使用「恢复账号」")

    if target["status"] != "active":
        await session.execute(SET_ACTIVE, {"user_id": user_id})
        await record_audit(
            session,
            action="admin.user.enable",
            actor_id=actor.user_id,
            target_type="user",
            target_id=str(user_id),
            detail={"email": str(target["email"])},
            actor_ip=client_ip(request),
        )
    await session.commit()
    return UserActionOut(id=user_id, status="active")


@router.post("/users/{user_id}:force-logout")
async def force_logout(
    user_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, int]:
    """撤销该账号全部 refresh token（access token 到期即失效，design 6.10.1）。"""
    require_system_admin(actor)
    target = await _load_target(session, user_id)
    revoked = await session.execute(REVOKE_ALL_TOKENS, {"user_id": user_id})
    count = int(getattr(revoked, "rowcount", 0) or 0)
    await record_audit(
        session,
        action="admin.user.force_logout",
        actor_id=actor.user_id,
        target_type="user",
        target_id=str(user_id),
        detail={"email": str(target["email"]), "revokedTokens": count},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"revoked": count}


@router.post("/users/{user_id}:restore", response_model=UserActionOut)
async def restore_user(
    user_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> UserActionOut:
    """注销宽限期内恢复账号（design 6.10.5 的运维操作入口）。"""
    require_system_admin(actor)
    target = await _load_target(session, user_id)
    if target["deletion_requested_at"] is None or target["purged_at"] is not None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "账号不在注销宽限期内，无需恢复")

    await session.execute(RESTORE_USER, {"user_id": user_id})
    await notify(session, [user_id], kind="user.restored")
    await record_audit(
        session,
        action="admin.user.restore",
        actor_id=actor.user_id,
        target_type="user",
        target_id=str(user_id),
        detail={"email": str(target["email"])},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return UserActionOut(id=user_id, status="active")


@router.post("/users/{user_id}:reset-password", response_model=ResetPasswordOut)
async def reset_user_password(
    user_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> ResetPasswordOut:
    """签发一次性重置令牌（明文只返回本次）；旧令牌立即作废，会话在用户改密后撤销。"""
    require_system_admin(actor)
    target = await _load_target(session, user_id)
    _ensure_not_purged(target)

    deleted = await session.execute(DELETE_UNUSED_RESET_TOKENS, {"user_id": user_id})
    token = new_refresh_token()
    expires_at = datetime.now(UTC) + timedelta(hours=RESET_TOKEN_TTL_HOURS)
    row = (
        await session.execute(
            INSERT_RESET_TOKEN,
            {
                "user_id": user_id,
                "token_hash": hash_refresh_token(token),
                "issued_by": actor.user_id,
                "expires_at": expires_at,
            },
        )
    ).mappings().one()
    await record_audit(
        session,
        action="admin.user.reset_password",
        actor_id=actor.user_id,
        target_type="user",
        target_id=str(user_id),
        detail={
            "email": str(target["email"]),
            "expiresInHours": RESET_TOKEN_TTL_HOURS,
            "supersededTokens": int(getattr(deleted, "rowcount", 0) or 0),
        },
        actor_ip=client_ip(request),
    )
    await session.commit()
    return ResetPasswordOut(token=token, expires_at=row["expires_at"])
