"""身份源（SSO）管理（design 6.12.2 / 6.12.5）：仅系统管理员。

- client_secret 只写不回显（返回 hasSecret）；
- 禁用或删除身份源会立即撤销该身份源关联用户的全部 refresh token；
- 创建/更新时校验发现文档可达（避免填错 issuer）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor, require_system_admin
from huagent.api.schemas import ApiModel
from huagent.common.crypto import SecretCipher, get_secret_cipher
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.oidc import OidcHttp, fetch_discovery, get_oidc_http

router = APIRouter(prefix="/admin/identity-providers", tags=["admin"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]
HttpDep = Annotated[OidcHttp, Depends(get_oidc_http)]
CipherDep = Annotated[SecretCipher, Depends(get_secret_cipher)]


class ProviderIn(ApiModel):
    name: str
    issuer_url: str
    client_id: str
    client_secret: str | None = None
    scopes: str = "openid profile email"
    enabled: bool = False
    allowed_email_domains: list[str] = []
    auto_join_org_id: UUID | None = None
    allow_auto_link: bool = True


class ProviderPatch(ApiModel):
    name: str | None = None
    issuer_url: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    scopes: str | None = None
    enabled: bool | None = None
    allowed_email_domains: list[str] | None = None
    auto_join_org_id: UUID | None = None
    allow_auto_link: bool | None = None


class ProviderOut(ApiModel):
    id: UUID
    name: str
    type: str
    issuer_url: str
    client_id: str
    scopes: str
    enabled: bool
    allowed_email_domains: list[str]
    auto_join_org_id: UUID | None
    allow_auto_link: bool
    has_secret: bool
    created_at: datetime
    updated_at: datetime


SELECT_PROVIDERS = text(
    """
    SELECT id, name, type, issuer_url, client_id, client_secret_enc IS NOT NULL AS has_secret, scopes,
           enabled, allowed_email_domains, auto_join_org_id, allow_auto_link, created_at, updated_at
    FROM identity_providers ORDER BY created_at
    """
)

INSERT_PROVIDER = text(
    """
    INSERT INTO identity_providers (name, type, issuer_url, client_id, client_secret_enc, scopes,
                                    enabled, allowed_email_domains, auto_join_org_id, allow_auto_link, created_by)
    VALUES (:name, 'oidc', :issuer_url, :client_id, :client_secret_enc, :scopes,
            :enabled, :domains, :auto_join_org_id, :allow_auto_link, :created_by)
    RETURNING id
    """
)

SELECT_PROVIDER = text(
    """
    SELECT id, name, type, issuer_url, client_id, client_secret_enc IS NOT NULL AS has_secret,
           client_secret_enc, scopes, enabled,
           allowed_email_domains, auto_join_org_id, allow_auto_link, created_at, updated_at
    FROM identity_providers WHERE id = :provider_id
    """
)

UPDATE_PROVIDER = text(
    """
    UPDATE identity_providers SET
      name = COALESCE(:name, name),
      issuer_url = COALESCE(:issuer_url, issuer_url),
      client_id = COALESCE(:client_id, client_id),
      client_secret_enc = COALESCE(:client_secret_enc, client_secret_enc),
      scopes = COALESCE(:scopes, scopes),
      enabled = COALESCE(:enabled, enabled),
      allowed_email_domains = COALESCE(:domains, allowed_email_domains),
      auto_join_org_id = CASE WHEN :clear_org THEN NULL ELSE COALESCE(:auto_join_org_id, auto_join_org_id) END,
      allow_auto_link = COALESCE(:allow_auto_link, allow_auto_link)
    WHERE id = :provider_id
    RETURNING id, name, type, issuer_url, client_id, client_secret_enc IS NOT NULL AS has_secret, scopes,
              enabled, allowed_email_domains, auto_join_org_id, allow_auto_link, created_at, updated_at
    """
)

DELETE_PROVIDER = text("DELETE FROM identity_providers WHERE id = :provider_id")

REVOKE_PROVIDER_SESSIONS = text(
    """
    UPDATE refresh_tokens SET revoked_at = now()
    WHERE revoked_at IS NULL
      AND user_id IN (SELECT user_id FROM user_identities WHERE provider_id = :provider_id)
    """
)


@router.get("", response_model=list[ProviderOut])
async def list_providers(actor: ActorDep, session: SessionDep) -> list[ProviderOut]:
    require_system_admin(actor)
    rows = (await session.execute(SELECT_PROVIDERS)).mappings().all()
    return [_to_out(row) for row in rows]


@router.post("", status_code=201, response_model=ProviderOut)
async def create_provider(
    payload: ProviderIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    http: HttpDep,
    cipher: CipherDep,
) -> ProviderOut:
    require_system_admin(actor)
    issuer = _validate_issuer(payload.issuer_url)
    # 校验发现文档可达（填错 issuer 时立即报错）
    await fetch_discovery(http, issuer, force=True)

    try:
        provider_id = (
            await session.execute(
                INSERT_PROVIDER,
                {
                    "name": payload.name.strip(),
                    "issuer_url": issuer,
                    "client_id": payload.client_id.strip(),
                    "client_secret_enc": cipher.encrypt(payload.client_secret) if payload.client_secret else None,
                    "scopes": payload.scopes,
                    "enabled": payload.enabled,
                    "domains": [item.lower() for item in payload.allowed_email_domains],
                    "auto_join_org_id": payload.auto_join_org_id,
                    "allow_auto_link": payload.allow_auto_link,
                    "created_by": actor.user_id,
                },
            )
        ).scalar_one()
    except Exception as exc:  # noqa: BLE001 —— name 唯一冲突
        raise AppError(ErrorCode.NAME_CONFLICT, f"身份源名称已存在：{exc}") from exc

    await record_audit(
        session,
        action="sso.provider.create",
        actor_id=actor.user_id,
        target_type="identity_provider",
        target_id=str(provider_id),
        detail={"name": payload.name, "issuerUrl": issuer},
        actor_ip=client_ip(request),
    )
    await session.commit()
    row = (await session.execute(SELECT_PROVIDER, {"provider_id": provider_id})).mappings().one()
    return _to_out(row)


@router.patch("/{provider_id}", response_model=ProviderOut)
async def update_provider(
    provider_id: UUID,
    payload: ProviderPatch,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    http: HttpDep,
    cipher: CipherDep,
) -> ProviderOut:
    require_system_admin(actor)
    existing = (await session.execute(SELECT_PROVIDER, {"provider_id": provider_id})).mappings().first()
    if existing is None:
        raise AppError(ErrorCode.NOT_FOUND, "身份源不存在")

    issuer = _validate_issuer(payload.issuer_url) if payload.issuer_url else None
    if issuer is not None:
        await fetch_discovery(http, issuer, force=True)

    row = (
        await session.execute(
            UPDATE_PROVIDER,
            {
                "provider_id": provider_id,
                "name": payload.name.strip() if payload.name else None,
                "issuer_url": issuer,
                "client_id": payload.client_id.strip() if payload.client_id else None,
                "client_secret_enc": cipher.encrypt(payload.client_secret) if payload.client_secret else None,
                "scopes": payload.scopes,
                "enabled": payload.enabled,
                "domains": [item.lower() for item in payload.allowed_email_domains]
                if payload.allowed_email_domains is not None
                else None,
                "auto_join_org_id": payload.auto_join_org_id,
                "clear_org": payload.auto_join_org_id is None
                and "auto_join_org_id" in payload.model_fields_set,
                "allow_auto_link": payload.allow_auto_link,
            },
        )
    ).mappings().one()

    revoked = 0
    if payload.enabled is False and bool(existing["enabled"]):
        result = await session.execute(REVOKE_PROVIDER_SESSIONS, {"provider_id": provider_id})
        revoked = int(getattr(result, "rowcount", 0) or 0)
    await record_audit(
        session,
        action="sso.provider.update",
        actor_id=actor.user_id,
        target_type="identity_provider",
        target_id=str(provider_id),
        detail={"enabled": payload.enabled, "revokedSessions": revoked},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return _to_out(row)


@router.delete("/{provider_id}")
async def delete_provider(
    provider_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    require_system_admin(actor)
    existing = (await session.execute(SELECT_PROVIDER, {"provider_id": provider_id})).mappings().first()
    if existing is None:
        raise AppError(ErrorCode.NOT_FOUND, "身份源不存在")

    result = await session.execute(REVOKE_PROVIDER_SESSIONS, {"provider_id": provider_id})
    revoked = int(getattr(result, "rowcount", 0) or 0)
    await session.execute(DELETE_PROVIDER, {"provider_id": provider_id})
    await record_audit(
        session,
        action="sso.provider.delete",
        actor_id=actor.user_id,
        target_type="identity_provider",
        target_id=str(provider_id),
        detail={"name": existing["name"], "revokedSessions": revoked},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"id": str(provider_id), "deleted": True, "revokedSessions": revoked}


def _validate_issuer(value: str) -> str:
    import urllib.parse

    issuer = value.strip().rstrip("/")
    parsed = urllib.parse.urlparse(issuer)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise AppError(ErrorCode.VALIDATION_FAILED, "issuerUrl 必须是 http(s) 地址")
    return issuer


def _to_out(row: RowMapping) -> ProviderOut:
    return ProviderOut(
        id=row["id"],
        name=str(row["name"]),
        type=str(row["type"]),
        issuer_url=str(row["issuer_url"]),
        client_id=str(row["client_id"]),
        scopes=str(row["scopes"]),
        enabled=bool(row["enabled"]),
        allowed_email_domains=list(row["allowed_email_domains"] or []),
        auto_join_org_id=row["auto_join_org_id"],
        allow_auto_link=bool(row["allow_auto_link"]),
        has_secret=bool(row["has_secret"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
