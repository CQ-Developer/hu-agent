"""认证接口（design 4.1 / 6.9.2 / 6.10.1）。

覆盖：注册、登录（设备绑定）、旋转刷新（重放检测）、登出、登录方式查询。
"""

from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.common.ratelimit import LoginGuard, get_login_guard
from huagent.common.security import (
    hash_password,
    hash_refresh_token,
    issue_access_token,
    new_refresh_token,
    normalize_email,
    validate_email,
    validate_password,
    verify_password,
)
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session

router = APIRouter(prefix="/auth", tags=["auth"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
GuardDep = Annotated[LoginGuard, Depends(get_login_guard)]


class DeviceIn(ApiModel):
    device_id: str
    platform: Literal["win32", "darwin", "linux"]
    app_version: str
    name: str | None = None


class RegisterIn(ApiModel):
    email: str
    password: str
    display_name: str


class LoginIn(ApiModel):
    email: str
    password: str
    device: DeviceIn


class RefreshIn(ApiModel):
    refresh_token: str


class LogoutIn(ApiModel):
    all_devices: bool = False
    device_id: str | None = None


class UserOut(ApiModel):
    id: UUID
    email: str
    display_name: str
    locale: str
    is_system_admin: bool


class TokenOut(ApiModel):
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str = "Bearer"  # noqa: S105 —— OAuth 固定字面量
    user: UserOut


class RefreshOut(ApiModel):
    access_token: str
    refresh_token: str
    expires_in: int
    token_type: str = "Bearer"  # noqa: S105 —— OAuth 固定字面量


class ProvidersOut(ApiModel):
    providers: list[dict[str, object]]


INSERT_USER = text(
    """
    INSERT INTO users (email, password_hash, display_name)
    VALUES (:email, :password_hash, :display_name)
    RETURNING id, email, display_name, locale, is_system_admin
    """
)

SELECT_USER = text(
    """
    SELECT id, email, password_hash, display_name, locale, is_system_admin, status, roles_version
    FROM users WHERE email = :email
    """
)

UPSERT_DEVICE = text(
    """
    INSERT INTO devices (user_id, device_id, platform, app_version, name, last_seen_at)
    VALUES (:user_id, :device_id, :platform, :app_version, :name, now())
    ON CONFLICT (user_id, device_id) DO UPDATE
    SET platform = EXCLUDED.platform,
        app_version = EXCLUDED.app_version,
        name = EXCLUDED.name,
        last_seen_at = now()
    """
)

INSERT_REFRESH = text(
    """
    INSERT INTO refresh_tokens (user_id, device_id, token_hash, family_id, expires_at)
    VALUES (:user_id, :device_id, :token_hash, :family_id, :expires_at)
    RETURNING id
    """
)

SELECT_REFRESH = text(
    """
    SELECT id, user_id, device_id, family_id, expires_at, revoked_at
    FROM refresh_tokens WHERE token_hash = :token_hash
    """
)

ROTATE_REFRESH = text(
    """
    UPDATE refresh_tokens SET revoked_at = now(), replaced_by_id = :replaced_by_id WHERE id = :id
    """
)

REVOKE_FAMILY = text(
    """
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE family_id = :family_id AND revoked_at IS NULL
    """
)

REVOKE_DEVICE = text(
    """
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE user_id = :user_id AND device_id = :device_id AND revoked_at IS NULL
    """
)

REVOKE_ALL = text(
    """
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE user_id = :user_id AND revoked_at IS NULL
    """
)

INSERT_NOTIFICATION = text(
    """
    INSERT INTO notifications (user_id, type, title, body, payload)
    VALUES (:user_id, :type, :title, :body, CAST(:payload AS jsonb))
    """
)


def _user_out(row: object) -> UserOut:
    fields = row  # sqlalchemy RowMapping
    return UserOut(
        id=fields["id"],  # type: ignore[index]
        email=str(fields["email"]),  # type: ignore[index]
        display_name=str(fields["display_name"]),  # type: ignore[index]
        locale=str(fields["locale"]),  # type: ignore[index]
        is_system_admin=bool(fields["is_system_admin"]),  # type: ignore[index]
    )


@router.get("/providers", response_model=ProvidersOut)
async def list_providers(session: SessionDep) -> ProvidersOut:
    settings = get_settings()
    rows = (
        await session.execute(
            text(
                "SELECT id, name FROM identity_providers WHERE enabled = true ORDER BY name"
            )
        )
    ).mappings().all()
    providers: list[dict[str, object]] = [
        {"id": "local", "type": "local", "name": "本地账号", "enabled": True},
        {
            "id": "registration",
            "type": "local",
            "name": "邮箱注册",
            "enabled": settings.auth_registration_enabled,
        },
    ]
    for row in rows:
        providers.append({"id": str(row["id"]), "type": "oidc", "name": str(row["name"]), "enabled": True})
    return ProvidersOut(providers=providers)


@router.post("/register", response_model=UserOut, status_code=201)
async def register(
    payload: RegisterIn,
    request: Request,
    session: SessionDep,
) -> UserOut:
    if not get_settings().auth_registration_enabled:
        raise AppError(ErrorCode.FORBIDDEN, "当前环境未开放注册")
    email = validate_email(payload.email)
    validate_password(payload.password)
    display_name = payload.display_name.strip()
    if not 1 <= len(display_name) <= 50:
        raise AppError(ErrorCode.VALIDATION_FAILED, "昵称长度需在 1-50 之间")

    existing = (await session.execute(SELECT_USER, {"email": email})).mappings().first()
    if existing is not None:
        raise AppError(ErrorCode.CONFLICT, "该邮箱已注册")

    row = (
        await session.execute(
            INSERT_USER,
            {
                "email": email,
                "password_hash": hash_password(payload.password),
                "display_name": display_name,
            },
        )
    ).mappings().one()
    await record_audit(
        session,
        action="auth.register",
        actor_id=row["id"],
        target_type="user",
        target_id=str(row["id"]),
        actor_ip=client_ip(request),
        user_agent=request.headers.get("user-agent"),
    )
    await session.commit()
    return _user_out(row)


@router.post("/login", response_model=TokenOut)
async def login(
    payload: LoginIn,
    request: Request,
    session: SessionDep,
    guard: GuardDep,
) -> TokenOut:
    ip = client_ip(request)
    email = normalize_email(payload.email)
    await guard.check_ip(ip)
    await guard.check_account(email)

    user = (await session.execute(SELECT_USER, {"email": email})).mappings().first()
    if user is None or not verify_password(payload.password, user["password_hash"]):
        await guard.on_failure(email)
        # 不区分“用户不存在/密码错误”，避免账号枚举
        raise AppError(ErrorCode.UNAUTHENTICATED, "邮箱或密码错误")
    if user["status"] != "active":
        raise AppError(ErrorCode.ACCOUNT_DISABLED, "账号已被禁用")

    await guard.on_success(email)
    device = payload.device
    return await issue_login_tokens(
        session,
        user,
        device_id=device.device_id,
        platform=device.platform,
        app_version=device.app_version,
        device_name=device.name,
        ip=ip,
        user_agent=request.headers.get("user-agent"),
        audit_action="auth.login",
        audit_detail={"platform": device.platform, "appVersion": device.app_version},
    )


async def load_user_by_id(session: AsyncSession, user_id: UUID) -> RowMapping | None:
    return (
        await session.execute(
            text(
                "SELECT id, email, display_name, locale, is_system_admin, status, roles_version, password_hash "
                "FROM users WHERE id = :user_id"
            ),
            {"user_id": user_id},
        )
    ).mappings().first()


async def issue_login_tokens(
    session: AsyncSession,
    user: RowMapping,
    *,
    device_id: str,
    platform: str,
    app_version: str,
    device_name: str | None,
    ip: str,
    user_agent: str | None,
    audit_action: str,
    audit_detail: dict[str, object] | None = None,
) -> TokenOut:
    """设备登记 + access/refresh 签发 + 审计（本地登录与 SSO exchange 共用）。"""
    resolved_device = device_id or "unknown"
    resolved_platform = platform if platform in {"win32", "darwin", "linux"} else "win32"
    await session.execute(
        UPSERT_DEVICE,
        {
            "user_id": user["id"],
            "device_id": resolved_device,
            "platform": resolved_platform,
            "app_version": app_version or "0.0.0",
            "name": device_name,
        },
    )

    access_token, expires_in = issue_access_token(
        user["id"], resolved_device, int(user["roles_version"])
    )
    refresh_token = new_refresh_token()
    await session.execute(
        INSERT_REFRESH,
        {
            "user_id": user["id"],
            "device_id": resolved_device,
            "token_hash": hash_refresh_token(refresh_token),
            "family_id": uuid.uuid7(),
            "expires_at": datetime.now(UTC)
            + timedelta(seconds=get_settings().refresh_token_ttl_seconds),
        },
    )
    await record_audit(
        session,
        action=audit_action,
        actor_id=user["id"],
        target_type="device",
        target_id=resolved_device,
        detail=audit_detail or {},
        actor_ip=ip,
        user_agent=user_agent,
    )
    await session.commit()
    return TokenOut(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=expires_in,
        user=_user_out(user),
    )


@router.post("/refresh", response_model=RefreshOut)
async def refresh(payload: RefreshIn, request: Request, session: SessionDep) -> RefreshOut:
    settings = get_settings()
    row = (
        await session.execute(SELECT_REFRESH, {"token_hash": hash_refresh_token(payload.refresh_token)})
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.UNAUTHENTICATED, "刷新令牌无效")

    if row["revoked_at"] is not None:
        # 重放检测：撤销该设备全部会话并通知用户（design 4.1 / 6.10.1）
        await session.execute(
            REVOKE_DEVICE, {"user_id": row["user_id"], "device_id": row["device_id"]}
        )
        await session.execute(
            INSERT_NOTIFICATION,
            {
                "user_id": row["user_id"],
                "type": "security.refresh_replay",
                "title": "检测到异常登录状态",
                "body": "刷新令牌被重复使用，该设备的登录会话已全部撤销，请重新登录。",
                "payload": json.dumps({"deviceId": row["device_id"]}),
            },
        )
        await record_audit(
            session,
            action="auth.refresh_replay",
            actor_id=row["user_id"],
            target_type="device",
            target_id=str(row["device_id"]),
            actor_ip=client_ip(request),
        )
        await session.commit()
        raise AppError(ErrorCode.REFRESH_REVOKED, "刷新令牌已失效，请重新登录")

    expires_at: datetime = row["expires_at"]
    if expires_at <= datetime.now(UTC):
        await session.execute(REVOKE_DEVICE, {"user_id": row["user_id"], "device_id": row["device_id"]})
        await session.commit()
        raise AppError(ErrorCode.REFRESH_REVOKED, "登录已过期，请重新登录")

    user = (
        await session.execute(
            text(
                "SELECT id, email, display_name, locale, is_system_admin, status, roles_version "
                "FROM users WHERE id = :user_id"
            ),
            {"user_id": row["user_id"]},
        )
    ).mappings().first()
    if user is None:
        raise AppError(ErrorCode.UNAUTHENTICATED, "用户不存在")
    if user["status"] != "active":
        raise AppError(ErrorCode.ACCOUNT_DISABLED, "账号已被禁用")

    access_token, expires_in = issue_access_token(
        user["id"], str(row["device_id"]), int(user["roles_version"])
    )
    refresh_token = new_refresh_token()
    inserted = (
        await session.execute(
            INSERT_REFRESH,
            {
                "user_id": user["id"],
                "device_id": row["device_id"],
                "token_hash": hash_refresh_token(refresh_token),
                "family_id": row["family_id"],
                "expires_at": datetime.now(UTC) + timedelta(seconds=settings.refresh_token_ttl_seconds),
            },
        )
    ).mappings().one()
    await session.execute(ROTATE_REFRESH, {"id": row["id"], "replaced_by_id": inserted["id"]})
    await session.commit()
    return RefreshOut(access_token=access_token, refresh_token=refresh_token, expires_in=expires_in)


@router.post("/logout")
async def logout(
    payload: LogoutIn,
    actor: Annotated[Actor, Depends(get_actor)],
    request: Request,
    session: SessionDep,
) -> dict[str, int]:
    if payload.all_devices:
        result = await session.execute(REVOKE_ALL, {"user_id": actor.user_id})
    else:
        device_id = payload.device_id or actor.device_id
        if not device_id:
            raise AppError(ErrorCode.VALIDATION_FAILED, "缺少 deviceId")
        result = await session.execute(
            REVOKE_DEVICE, {"user_id": actor.user_id, "device_id": device_id}
        )
    await record_audit(
        session,
        action="auth.logout",
        actor_id=actor.user_id,
        target_type="device",
        target_id="all" if payload.all_devices else (payload.device_id or actor.device_id or ""),
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"revoked": int(getattr(result, "rowcount", 0) or 0)}
