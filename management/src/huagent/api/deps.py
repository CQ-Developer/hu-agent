"""API 依赖：当前登录用户（design 6.9.2）。

access token 只作身份凭证；权限每次查（RBAC 在阶段 5）。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.common.errors import AppError, ErrorCode
from huagent.common.security import decode_access_token
from huagent.domain.db import get_session


@dataclass(frozen=True)
class Actor:
    user_id: UUID
    email: str
    display_name: str
    is_system_admin: bool
    roles_version: int
    device_id: str | None

    @property
    def ip(self) -> str | None:
        return None


SELECT_ACTOR = text(
    """
    SELECT id, email, display_name, is_system_admin, status, roles_version
    FROM users WHERE id = :user_id
    """
)


async def get_actor(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Actor:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise AppError(ErrorCode.UNAUTHENTICATED, "缺少访问令牌")

    payload = decode_access_token(token)
    try:
        user_id = UUID(str(payload["sub"]))
    except (KeyError, ValueError) as exc:
        raise AppError(ErrorCode.UNAUTHENTICATED, "无效的访问令牌") from exc

    row = (await session.execute(SELECT_ACTOR, {"user_id": user_id})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.UNAUTHENTICATED, "用户不存在")
    if row["status"] != "active":
        raise AppError(ErrorCode.ACCOUNT_DISABLED, "账号已被禁用")

    device_id = payload.get("device_id")
    return Actor(
        user_id=user_id,
        email=str(row["email"]),
        display_name=str(row["display_name"]),
        is_system_admin=bool(row["is_system_admin"]),
        roles_version=int(row["roles_version"]),
        device_id=str(device_id) if device_id else None,
    )


def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"
