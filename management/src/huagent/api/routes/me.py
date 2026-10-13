"""个人资料与设备管理（design 4.1 / 6.9.2）。"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session

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
