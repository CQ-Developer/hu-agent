"""个人资料与设备管理（design 4.1 / 6.9.2）。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.common.security import verify_password
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.settings import get_int_setting

router = APIRouter(prefix="/me", tags=["me"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]


class ProfileOut(ApiModel):
    id: UUID
    email: str
    display_name: str
    locale: str
    is_system_admin: bool


class ProfilePatch(ApiModel):
    display_name: str | None = None
    locale: Literal["zh-CN", "en-US"] | None = None


class DeviceOut(ApiModel):
    id: UUID
    device_id: str
    platform: str
    app_version: str
    name: str | None
    last_seen_at: datetime | None
    created_at: datetime
    current: bool


class DevicesOut(ApiModel):
    devices: list[DeviceOut]


class NotificationOut(ApiModel):
    id: UUID
    type: str
    title: str
    body: str
    payload: dict[str, object]
    read_at: datetime | None
    created_at: datetime


class NotificationsOut(ApiModel):
    items: list[NotificationOut]
    unread: int


class NotificationPatch(ApiModel):
    ids: list[UUID] | None = None
    all: bool = False


class DeleteAccountIn(ApiModel):
    # 二次确认：输入自己的邮箱；本地账号还需提供密码（SSO 账号无密码）
    confirm_email: str
    password: str | None = None
    reason: str | None = None


class DeleteAccountOut(ApiModel):
    status: str
    purge_after: datetime
    grace_days: int


SELECT_PROFILE = text(
    "SELECT id, email, display_name, locale, is_system_admin FROM users WHERE id = :user_id"
)

UPDATE_PROFILE = text(
    """
    UPDATE users SET display_name = COALESCE(:display_name, display_name),
                     locale = COALESCE(:locale, locale)
    WHERE id = :user_id
    RETURNING id, email, display_name, locale, is_system_admin
    """
)

SELECT_DEVICES = text(
    """
    SELECT id, device_id, platform, app_version, name, last_seen_at, created_at
    FROM devices WHERE user_id = :user_id ORDER BY last_seen_at DESC NULLS LAST, created_at DESC
    """
)

DELETE_DEVICE = text("DELETE FROM devices WHERE user_id = :user_id AND device_id = :device_id")

REVOKE_DEVICE_TOKENS = text(
    """
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE user_id = :user_id AND device_id = :device_id AND revoked_at IS NULL
    """
)


@router.get("", response_model=ProfileOut)
async def get_profile(actor: ActorDep, session: SessionDep) -> ProfileOut:
    row = (await session.execute(SELECT_PROFILE, {"user_id": actor.user_id})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "用户不存在")
    return ProfileOut(**dict(row))


@router.patch("", response_model=ProfileOut)
async def update_profile(
    payload: ProfilePatch,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> ProfileOut:
    display_name = payload.display_name.strip() if payload.display_name else None
    if display_name is not None and not 1 <= len(display_name) <= 50:
        raise AppError(ErrorCode.VALIDATION_FAILED, "昵称长度需在 1-50 之间")
    row = (
        await session.execute(
            UPDATE_PROFILE,
            {"user_id": actor.user_id, "display_name": display_name, "locale": payload.locale},
        )
    ).mappings().one()
    await record_audit(
        session,
        action="me.update",
        actor_id=actor.user_id,
        target_type="user",
        target_id=str(actor.user_id),
        detail={"displayName": display_name, "locale": payload.locale},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return ProfileOut(**dict(row))


@router.get("/devices", response_model=DevicesOut)
async def list_devices(actor: ActorDep, session: SessionDep) -> DevicesOut:
    rows = (await session.execute(SELECT_DEVICES, {"user_id": actor.user_id})).mappings().all()
    return DevicesOut(
        devices=[
            DeviceOut(**dict(row), current=str(row["device_id"]) == actor.device_id) for row in rows
        ]
    )


@router.delete("/devices/{device_id}")
async def revoke_device(
    device_id: str,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    result = await session.execute(
        REVOKE_DEVICE_TOKENS, {"user_id": actor.user_id, "device_id": device_id}
    )
    deleted = await session.execute(DELETE_DEVICE, {"user_id": actor.user_id, "device_id": device_id})
    if int(getattr(deleted, "rowcount", 0) or 0) == 0:
        raise AppError(ErrorCode.NOT_FOUND, "设备不存在")
    await record_audit(
        session,
        action="me.device.revoke",
        actor_id=actor.user_id,
        target_type="device",
        target_id=device_id,
        detail={"revokedTokens": int(getattr(result, "rowcount", 0) or 0)},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"deviceId": device_id, "revokedTokens": int(getattr(result, "rowcount", 0) or 0)}


SELECT_NOTIFICATIONS = text(
    """
    SELECT id, type, title, body, payload, read_at, created_at
    FROM notifications WHERE user_id = :user_id AND (:unread_only = false OR read_at IS NULL)
    ORDER BY created_at DESC LIMIT :limit
    """
)

COUNT_UNREAD = text("SELECT count(*) FROM notifications WHERE user_id = :user_id AND read_at IS NULL")

MARK_READ = text(
    """
    UPDATE notifications SET read_at = now()
    WHERE user_id = :user_id AND read_at IS NULL AND (CAST(:all AS boolean) OR id = ANY(:ids))
    """
)


@router.get("/notifications", response_model=NotificationsOut)
async def list_notifications(
    actor: ActorDep,
    session: SessionDep,
    unread_only: bool = Query(default=False),
    limit: int = Query(default=50, ge=1, le=200),
) -> NotificationsOut:
    rows = (
        await session.execute(
            SELECT_NOTIFICATIONS,
            {"user_id": actor.user_id, "unread_only": unread_only, "limit": limit},
        )
    ).mappings().all()
    unread = int((await session.execute(COUNT_UNREAD, {"user_id": actor.user_id})).scalar_one())
    items = []
    for row in rows:
        payload = row["payload"]
        items.append(
            NotificationOut(
                id=row["id"],
                type=str(row["type"]),
                title=str(row["title"]),
                body=str(row["body"]),
                payload=dict(payload) if isinstance(payload, dict) else {},
                read_at=row["read_at"],
                created_at=row["created_at"],
            )
        )
    return NotificationsOut(items=items, unread=unread)


@router.patch("/notifications")
async def mark_notifications(
    payload: NotificationPatch,
    actor: ActorDep,
    session: SessionDep,
) -> dict[str, int]:
    if not payload.all and not payload.ids:
        raise AppError(ErrorCode.VALIDATION_FAILED, "请提供 ids 或 all=true")
    result = await session.execute(
        MARK_READ,
        {
            "user_id": actor.user_id,
            "ids": payload.ids or [],
            "all": payload.all,
        },
    )
    await session.commit()
    return {"updated": int(getattr(result, "rowcount", 0) or 0)}


SELECT_IDENTITIES = text(
    """
    SELECT i.id, i.provider_id, p.name AS provider_name, i.email, i.last_login_at, i.created_at
    FROM user_identities i JOIN identity_providers p ON p.id = i.provider_id
    WHERE i.user_id = :user_id ORDER BY i.created_at
    """
)

COUNT_IDENTITIES = text("SELECT count(*) FROM user_identities WHERE user_id = :user_id")

SELECT_USER_PASSWORD = text("SELECT password_hash FROM users WHERE id = :user_id")

DELETE_IDENTITY = text("DELETE FROM user_identities WHERE id = :id AND user_id = :user_id")


class IdentityOut(ApiModel):
    id: UUID
    provider_id: UUID
    provider_name: str
    email: str | None
    last_login_at: datetime | None
    created_at: datetime


@router.get("/identities", response_model=list[IdentityOut])
async def list_identities(actor: ActorDep, session: SessionDep) -> list[IdentityOut]:
    rows = (await session.execute(SELECT_IDENTITIES, {"user_id": actor.user_id})).mappings().all()
    return [IdentityOut(**dict(row)) for row in rows]


@router.delete("/identities/{identity_id}")
async def unlink_identity(
    identity_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    """解绑身份源；必须保留至少一种可用登录方式（design 6.12.5）。"""
    password_hash = (
        await session.execute(SELECT_USER_PASSWORD, {"user_id": actor.user_id})
    ).scalar_one_or_none()
    total = int((await session.execute(COUNT_IDENTITIES, {"user_id": actor.user_id})).scalar_one())
    if not password_hash and total <= 1:
        raise AppError(ErrorCode.CONFLICT, "解绑后没有任何可用登录方式，请先设置本地密码")

    result = await session.execute(DELETE_IDENTITY, {"id": identity_id, "user_id": actor.user_id})
    if int(getattr(result, "rowcount", 0) or 0) == 0:
        raise AppError(ErrorCode.NOT_FOUND, "绑定关系不存在")
    await record_audit(
        session,
        action="me.identity.unlink",
        actor_id=actor.user_id,
        target_type="user_identity",
        target_id=str(identity_id),
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"id": str(identity_id), "unlinked": True}


# ---------- 数据生命周期（design 6.10.5）----------

REVOKE_ALL_TOKENS = text(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :user_id AND revoked_at IS NULL"
)
REQUEST_DELETION = text(
    """
    UPDATE users SET status = 'disabled', deletion_requested_at = now(), updated_at = now()
    WHERE id = :user_id
    RETURNING id, deletion_requested_at
    """
)
SELECT_MEMBERSHIPS = text(
    """
    SELECT 'org' AS kind, o.id, o.name, m.role, m.status, m.joined_at
    FROM org_members m JOIN orgs o ON o.id = m.org_id
    WHERE m.user_id = :user_id
    UNION ALL
    SELECT 'team' AS kind, t.id, t.name, m.role, m.status, m.joined_at
    FROM team_members m JOIN teams t ON t.id = m.team_id
    WHERE m.user_id = :user_id
    ORDER BY kind, name
    """
)
SELECT_MY_ACTIVATIONS = text(
    """
    SELECT resource_type, ref_id, name, version, enabled, device_id, reported_at
    FROM activation_reports WHERE user_id = :user_id ORDER BY reported_at DESC LIMIT 1000
    """
)
SELECT_MY_USAGE_DAILY = text(
    """
    SELECT day, provider, model, input_tokens, output_tokens, requests, errors
    FROM usage_daily WHERE user_id = :user_id ORDER BY day DESC LIMIT 730
    """
)
SELECT_MY_AUDIT = text(
    """
    SELECT action, target_type, target_id, detail, created_at
    FROM audit_logs WHERE actor_id = :user_id ORDER BY id DESC LIMIT 1000
    """
)


def _to_camel(value: object) -> object:
    """导出文档统一 camelCase（与 API 其余部分一致，便于人读）。"""
    if isinstance(value, dict):
        return {_camel_key(str(key)): _to_camel(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_to_camel(item) for item in value]
    return value


def _camel_key(key: str) -> str:
    head, *rest = key.split("_")
    return head + "".join(part.capitalize() for part in rest)


@router.get("/export")
async def export_my_data(actor: ActorDep, request: Request, session: SessionDep) -> dict[str, object]:
    """导出本人数据（design 6.10.5）：资料、成员关系、设备、身份、通知、激活、用量日聚合、本人审计。"""
    profile = (await session.execute(SELECT_PROFILE, {"user_id": actor.user_id})).mappings().first()
    if profile is None:
        raise AppError(ErrorCode.NOT_FOUND, "账号不存在")

    async def rows(statement: Any, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        result = await session.execute(statement, params or {"user_id": actor.user_id})
        return [dict(row) for row in result.mappings().all()]

    payload: dict[str, object] = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "profile": dict(profile),
        "memberships": await rows(SELECT_MEMBERSHIPS),
        "devices": await rows(SELECT_DEVICES),
        "identities": await rows(SELECT_IDENTITIES),
        "notifications": await rows(
            SELECT_NOTIFICATIONS, {"user_id": actor.user_id, "unread_only": False, "limit": 1000}
        ),
        "activations": await rows(SELECT_MY_ACTIVATIONS),
        "usageDaily": await rows(SELECT_MY_USAGE_DAILY),
        "audit": await rows(SELECT_MY_AUDIT),
        "retention": {
            "usageEventsDays": await get_int_setting(session, "usage.retention_days", 90),
            "usageDailyDays": await get_int_setting(session, "usage.daily_retention_days", 730),
        },
    }
    await record_audit(
        session,
        action="account.export",
        actor_id=actor.user_id,
        actor_ip=client_ip(request),
        detail={"sections": sorted(payload.keys())},
    )
    await session.commit()
    return _to_camel(payload)  # type: ignore[return-value]


@router.post(":delete")
async def delete_my_account(
    payload: DeleteAccountIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> DeleteAccountOut:
    """申请注销：立即停用并撤销全部会话；宽限期后由 worker 硬删 PII（design 6.10.5）。"""
    if payload.confirm_email.strip().lower() != actor.email.lower():
        raise AppError(ErrorCode.VALIDATION_FAILED, "确认邮箱与当前账号不一致")

    credentials = (
        await session.execute(
            text("SELECT password_hash FROM users WHERE id = :user_id"), {"user_id": actor.user_id}
        )
    ).mappings().first()
    password_hash = credentials["password_hash"] if credentials else None
    if password_hash and not verify_password(payload.password or "", str(password_hash)):
        raise AppError(ErrorCode.UNAUTHENTICATED, "密码不正确")

    # 与 worker 清理任务保持同一来源（system_settings 优先，环境变量为默认）
    grace_days = await get_int_setting(
        session, "account.deletion_grace_days", get_settings().account_deletion_grace_days
    )
    updated = (await session.execute(REQUEST_DELETION, {"user_id": actor.user_id})).mappings().first()
    if updated is None:
        raise AppError(ErrorCode.NOT_FOUND, "账号不存在")
    revoked = await session.execute(REVOKE_ALL_TOKENS, {"user_id": actor.user_id})

    await record_audit(
        session,
        action="account.delete_requested",
        actor_id=actor.user_id,
        actor_ip=client_ip(request),
        detail={
            "graceDays": grace_days,
            "reason": payload.reason,
            "revokedTokens": int(getattr(revoked, "rowcount", 0) or 0),
        },
    )
    await session.commit()
    return DeleteAccountOut(
        status="disabled",
        purge_after=updated["deletion_requested_at"] + timedelta(days=grace_days),
        grace_days=grace_days,
    )
