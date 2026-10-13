"""SSO / OIDC 登录（design 6.12）：authorize → callback → 一次性 code → exchange。

- authorize：校验回跳地址，生成 state/nonce 与服务端 PKCE verifier（加密存储），302 到 IdP
- callback：校验 state，用服务端 verifier 换 token，验签 ID Token（或回退 userinfo），
  JIT 建号/绑定，写审计，302 回客户端并携带一次性 code
- exchange：校验一次性 code 与客户端 PKCE，签发本地 access + refresh token
"""

from __future__ import annotations

import hashlib
import urllib.parse
from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import client_ip
from huagent.api.routes.auth import TokenOut, issue_login_tokens, load_user_by_id
from huagent.api.schemas import ApiModel
from huagent.common.config import get_settings
from huagent.common.crypto import SecretCipher, get_secret_cipher
from huagent.common.errors import AppError, ErrorCode
from huagent.common.security import new_refresh_token
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.oidc import (
    IdTokenClaims,
    OidcDiscovery,
    OidcError,
    OidcHttp,
    OidcVerifier,
    build_authorize_url,
    code_challenge_s256,
    fetch_discovery,
    get_oidc_http,
    get_oidc_verifier,
    new_verifier,
    verify_pkce,
)

router = APIRouter(prefix="/auth/sso", tags=["sso"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
HttpDep = Annotated[OidcHttp, Depends(get_oidc_http)]
VerifierDep = Annotated[OidcVerifier, Depends(get_oidc_verifier)]
CipherDep = Annotated[SecretCipher, Depends(get_secret_cipher)]


class ExchangeIn(ApiModel):
    code: str
    code_verifier: str


SELECT_PROVIDER = text(
    """
    SELECT id, name, issuer_url, client_id, client_secret_enc, scopes, enabled,
           allowed_email_domains, auto_join_org_id, allow_auto_link
    FROM identity_providers WHERE id = :provider_id
    """
)

INSERT_REQUEST = text(
    """
    INSERT INTO sso_login_requests (provider_id, idp_state_hash, code_verifier_enc, nonce, client_state,
                                    redirect_uri, code_challenge, code_challenge_method, device_id,
                                    platform, app_version, device_name, expires_at)
    VALUES (:provider_id, :idp_state_hash, :code_verifier_enc, :nonce, :client_state,
            :redirect_uri, :code_challenge, :code_challenge_method, :device_id,
            :platform, :app_version, :device_name, :expires_at)
    """
)

SELECT_REQUEST = text(
    """
    SELECT id, provider_id, code_verifier_enc, nonce, client_state, redirect_uri,
           code_challenge, code_challenge_method, device_id, platform, app_version, device_name,
           status, expires_at
    FROM sso_login_requests WHERE idp_state_hash = :state_hash FOR UPDATE
    """
)

COMPLETE_REQUEST = text(
    "UPDATE sso_login_requests SET status = :status, error = :error WHERE id = :id"
)

INSERT_CODE = text(
    """
    INSERT INTO sso_login_codes (code_hash, user_id, provider_id, code_challenge, code_challenge_method,
                                 device_id, platform, app_version, device_name, expires_at)
    VALUES (:code_hash, :user_id, :provider_id, :code_challenge, :code_challenge_method,
            :device_id, :platform, :app_version, :device_name, :expires_at)
    """
)

SELECT_CODE = text(
    """
    SELECT id, user_id, provider_id, code_challenge, code_challenge_method, device_id, platform,
           app_version, device_name, expires_at, used_at
    FROM sso_login_codes WHERE code_hash = :code_hash FOR UPDATE
    """
)

MARK_CODE_USED = text("UPDATE sso_login_codes SET used_at = now() WHERE id = :id")

SELECT_IDENTITY = text(
    "SELECT id, user_id FROM user_identities WHERE provider_id = :provider_id AND subject = :subject"
)

SELECT_USER_BY_EMAIL = text(
    "SELECT id, email, display_name, locale, is_system_admin, status, roles_version, password_hash "
    "FROM users WHERE email = :email"
)

INSERT_SSO_USER = text(
    """
    INSERT INTO users (email, password_hash, display_name, email_verified_at)
    VALUES (:email, NULL, :display_name, now())
    RETURNING id, email, display_name, locale, is_system_admin, status, roles_version, password_hash
    """
)

UPSERT_IDENTITY = text(
    """
    INSERT INTO user_identities (user_id, provider_id, subject, email, last_login_at)
    VALUES (:user_id, :provider_id, :subject, :email, now())
    ON CONFLICT (provider_id, subject) DO UPDATE SET last_login_at = now(), email = EXCLUDED.email
    """
)

JOIN_ORG = text(
    """
    INSERT INTO org_members (org_id, user_id, role) VALUES (:org_id, :user_id, 'member')
    ON CONFLICT (org_id, user_id) DO NOTHING
    """
)


@router.get("/{provider_id}/authorize")
async def authorize(
    provider_id: UUID,
    redirect_uri: Annotated[str, Query()],
    state: Annotated[str, Query(min_length=8, max_length=200)],
    code_challenge: Annotated[str, Query(min_length=16, max_length=200)],
    session: SessionDep,
    http: HttpDep,
    cipher: CipherDep,
    code_challenge_method: Annotated[str, Query(pattern="^(S256|plain)$")] = "S256",
    device_id: Annotated[str | None, Query()] = None,
    platform: Annotated[str | None, Query()] = None,
    app_version: Annotated[str | None, Query()] = None,
    device_name: Annotated[str | None, Query()] = None,
) -> RedirectResponse:
    provider = await _load_provider(session, provider_id)
    validate_redirect_uri(redirect_uri)
    discovery = await fetch_discovery(http, str(provider["issuer_url"]))

    idp_state = new_verifier()
    nonce = new_verifier()
    idp_verifier = new_verifier()
    await session.execute(
        INSERT_REQUEST,
        {
            "provider_id": provider_id,
            "idp_state_hash": _hash(idp_state),
            "code_verifier_enc": cipher.encrypt(idp_verifier),
            "nonce": nonce,
            "client_state": state,
            "redirect_uri": redirect_uri,
            "code_challenge": code_challenge,
            "code_challenge_method": code_challenge_method,
            "device_id": device_id,
            "platform": platform,
            "app_version": app_version,
            "device_name": device_name,
            "expires_at": datetime.now(UTC)
            + timedelta(seconds=get_settings().sso_login_request_ttl_seconds),
        },
    )
    await record_audit(
        session,
        action="auth.sso.authorize",
        target_type="identity_provider",
        target_id=str(provider_id),
        detail={"redirectUri": redirect_uri},
    )
    await session.commit()

    return RedirectResponse(
        build_authorize_url(
            discovery.authorization_endpoint,
            client_id=str(provider["client_id"]),
            redirect_uri=_callback_url(),
            scopes=str(provider["scopes"]),
            state=idp_state,
            nonce=nonce,
            code_challenge=code_challenge_s256(idp_verifier),
        ),
        status_code=302,
    )


@router.get("/callback")
async def callback(
    session: SessionDep,
    http: HttpDep,
    verifier: VerifierDep,
    cipher: CipherDep,
    request: Request,
    state: Annotated[str, Query()],
    code: Annotated[str | None, Query()] = None,
    error: Annotated[str | None, Query()] = None,
    error_description: Annotated[str | None, Query()] = None,
) -> RedirectResponse:
    row = (await session.execute(SELECT_REQUEST, {"state_hash": _hash(state)})).mappings().first()
    if row is None or row["status"] != "pending":
        raise AppError(ErrorCode.NOT_FOUND, "SSO 登录请求不存在或已处理")
    if row["expires_at"] <= datetime.now(UTC):
        await session.execute(COMPLETE_REQUEST, {"id": row["id"], "status": "expired", "error": "timeout"})
        await session.commit()
        return _redirect_error(
            str(row["redirect_uri"]),
            str(row["client_state"]),
            "SSO_LOGIN_TIMEOUT",
            "登录请求已过期",
        )

    if error:
        message = error_description or error
        await session.execute(COMPLETE_REQUEST, {"id": row["id"], "status": "failed", "error": message[:200]})
        await session.commit()
        return _redirect_error(str(row["redirect_uri"]), str(row["client_state"]), error, message)

    provider = await _load_provider(session, row["provider_id"], require_enabled=True)
    discovery = await fetch_discovery(http, str(provider["issuer_url"]))
    try:
        claims = await _resolve_claims(
            http=http,
            verifier=verifier,
            discovery=discovery,
            provider=provider,
            cipher=cipher,
            login_request=row,
            code=code,
        )
        user_row = await _provision_user(
            session,
            provider=provider,
            subject=claims.subject,
            email=claims.email,
            email_verified=claims.email_verified,
            display_name=claims.name,
        )
    except OidcError as exc:
        await session.execute(COMPLETE_REQUEST, {"id": row["id"], "status": "failed", "error": str(exc)[:200]})
        await session.commit()
        return _redirect_error(str(row["redirect_uri"]), str(row["client_state"]), "SSO_FAILED", str(exc))

    one_time = new_refresh_token()
    await session.execute(
        INSERT_CODE,
        {
            "code_hash": _hash(one_time),
            "user_id": user_row["id"],
            "provider_id": provider["id"],
            "code_challenge": row["code_challenge"],
            "code_challenge_method": row["code_challenge_method"],
            "device_id": row["device_id"],
            "platform": row["platform"],
            "app_version": row["app_version"],
            "device_name": row["device_name"],
            "expires_at": datetime.now(UTC) + timedelta(seconds=get_settings().sso_code_ttl_seconds),
        },
    )
    await session.execute(COMPLETE_REQUEST, {"id": row["id"], "status": "completed", "error": None})
    await record_audit(
        session,
        action="auth.sso.login",
        actor_id=user_row["id"],
        target_type="identity_provider",
        target_id=str(provider["id"]),
        detail={"subject": claims.subject, "email": claims.email},
        actor_ip=client_ip(request),
    )
    await session.commit()

    separator = "&" if "?" in str(row["redirect_uri"]) else "?"
    return RedirectResponse(
        f"{row['redirect_uri']}{separator}code={one_time}&state={row['client_state']}", status_code=302
    )


@router.post("/exchange", response_model=TokenOut)
async def exchange(
    payload: ExchangeIn,
    request: Request,
    session: SessionDep,
) -> TokenOut:
    row = (await session.execute(SELECT_CODE, {"code_hash": _hash(payload.code)})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.UNAUTHENTICATED, "一次性登录码无效")
    if row["used_at"] is not None:
        raise AppError(ErrorCode.REFRESH_REVOKED, "一次性登录码已被使用")
    if row["expires_at"] <= datetime.now(UTC):
        await session.execute(MARK_CODE_USED, {"id": row["id"]})
        await session.commit()
        raise AppError(ErrorCode.REFRESH_REVOKED, "一次性登录码已过期，请重新登录")
    if not verify_pkce(payload.code_verifier, str(row["code_challenge"]), str(row["code_challenge_method"])):
        raise AppError(ErrorCode.UNAUTHENTICATED, "PKCE 校验失败")

    await session.execute(MARK_CODE_USED, {"id": row["id"]})
    user = await load_user_by_id(session, row["user_id"])
    if user is None:
        raise AppError(ErrorCode.UNAUTHENTICATED, "用户不存在")
    if user["status"] != "active":
        raise AppError(ErrorCode.ACCOUNT_DISABLED, "账号已被禁用")

    tokens = await issue_login_tokens(
        session,
        user,
        device_id=str(row["device_id"] or ""),
        platform=str(row["platform"] or "win32"),
        app_version=str(row["app_version"] or "0.0.0"),
        device_name=row["device_name"],
        ip=client_ip(request),
        user_agent=request.headers.get("user-agent"),
        audit_action="auth.sso.exchange",
    )
    return tokens


async def _resolve_claims(
    *,
    http: OidcHttp,
    verifier: OidcVerifier,
    discovery: OidcDiscovery,
    provider: RowMapping,
    cipher: SecretCipher,
    login_request: RowMapping,
    code: str | None,
) -> IdTokenClaims:
    if not code:
        raise OidcError("IdP 未返回授权码")
    secret_enc = provider["client_secret_enc"]
    client_secret = cipher.decrypt(str(secret_enc)) if secret_enc else None
    token_payload = await _post_token(
        http,
        discovery,
        client_id=str(provider["client_id"]),
        client_secret=client_secret,
        code=code,
        redirect_uri=_callback_url(),
        code_verifier=cipher.decrypt(str(login_request["code_verifier_enc"])),
    )
    id_token = token_payload.get("id_token")
    if id_token:
        claims = await verifier.verify(
            id_token=str(id_token),
            discovery=discovery,
            client_id=str(provider["client_id"]),
            client_secret=client_secret,
            nonce=str(login_request["nonce"]),
        )
    else:
        # 少数 IdP 不返回 id_token：退化为 userinfo（仍要求 email_verified）
        claims = await _userinfo_claims(http, discovery, token_payload.get("access_token"))

    if (not claims.email or not claims.email_verified) and discovery.userinfo_endpoint:
        userinfo = await _userinfo_claims(http, discovery, token_payload.get("access_token"))
        claims = userinfo if userinfo.email else claims
    return claims


async def _post_token(
    http: OidcHttp,
    discovery: OidcDiscovery,
    *,
    client_id: str,
    client_secret: str | None,
    code: str,
    redirect_uri: str,
    code_verifier: str,
) -> dict[str, object]:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_id,
        "code_verifier": code_verifier,
    }
    if client_secret:
        data["client_secret"] = client_secret
    try:
        return await http.post_form(discovery.token_endpoint, data)
    except Exception as exc:  # noqa: BLE001 —— 网络或 IdP 拒绝
        raise OidcError(f"向 IdP 换取令牌失败：{exc}") from exc


async def _userinfo_claims(
    http: OidcHttp, discovery: OidcDiscovery, access_token: object
) -> IdTokenClaims:
    if not discovery.userinfo_endpoint or not access_token:
        raise OidcError("IdP 未返回 id_token，且无法通过 userinfo 获取身份")
    try:
        payload = await http.get_json(
            discovery.userinfo_endpoint, headers={"authorization": f"Bearer {access_token}"}
        )
    except Exception as exc:  # noqa: BLE001
        raise OidcError(f"获取 userinfo 失败：{exc}") from exc
    subject = str(payload.get("sub") or "")
    if not subject:
        raise OidcError("userinfo 缺少 sub")
    return IdTokenClaims(
        subject=subject,
        email=str(payload.get("email") or ""),
        email_verified=bool(payload.get("email_verified", False)),
        name=payload.get("name") or payload.get("preferred_username"),
    )


async def _provision_user(
    session: AsyncSession,
    *,
    provider: RowMapping,
    subject: str,
    email: str,
    email_verified: bool,
    display_name: str | None,
) -> RowMapping:
    """design 6.12.4：先按 (provider, subject) 匹配，再按邮箱绑定/建号。"""
    identity = (
        await session.execute(
            SELECT_IDENTITY, {"provider_id": provider["id"], "subject": subject}
        )
    ).mappings().first()
    if identity is not None:
        await session.execute(
            UPSERT_IDENTITY,
            {
                "user_id": identity["user_id"],
                "provider_id": provider["id"],
                "subject": subject,
                "email": email or None,
            },
        )
        user = await load_user_by_id(session, identity["user_id"])
        if user is None:
            raise OidcError("绑定的用户不存在")
        return user

    if not email_verified:
        raise OidcError("IdP 未确认邮箱已验证，拒绝登录")
    domains = list(provider["allowed_email_domains"] or [])
    if domains:
        domain = email.rsplit("@", 1)[-1].lower() if "@" in email else ""
        if domain not in {item.lower() for item in domains}:
            raise OidcError(f"邮箱域名不在允许列表内：{domain or email}")

    existing = (await session.execute(SELECT_USER_BY_EMAIL, {"email": email})).mappings().first()
    if existing is not None:
        if not bool(provider["allow_auto_link"]):
            raise OidcError("管理员要求禁止自动绑定已有账号，请联系管理员")
        user = existing
    else:
        display = (display_name or email.split("@")[0])[:50]
        user = (
            await session.execute(
                INSERT_SSO_USER, {"email": email, "display_name": display}
            )
        ).mappings().one()

    await session.execute(
        UPSERT_IDENTITY,
        {
            "user_id": user["id"],
            "provider_id": provider["id"],
            "subject": subject,
            "email": email,
        },
    )
    auto_join = provider["auto_join_org_id"]
    if auto_join is not None:
        await session.execute(JOIN_ORG, {"org_id": auto_join, "user_id": user["id"]})
    return user


async def _load_provider(
    session: AsyncSession, provider_id: UUID, *, require_enabled: bool = True
) -> RowMapping:
    provider = (
        await session.execute(SELECT_PROVIDER, {"provider_id": provider_id})
    ).mappings().first()
    if provider is None or (require_enabled and not provider["enabled"]):
        raise AppError(ErrorCode.NOT_FOUND, "身份源不存在或未启用")
    return provider


def validate_redirect_uri(redirect_uri: str) -> None:
    """回环地址（桌面）或管理台来源（cors_origins）之外一律拒绝。"""
    settings = get_settings()
    parsed = _parse(redirect_uri)
    if parsed is None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "redirect_uri 非法")
    host = (parsed.hostname or "").lower()
    loopback = host in {"127.0.0.1", "::1", "localhost"}
    if loopback and settings.sso_allow_any_loopback:
        return
    origins = {_normalize_origin(item) for item in settings.cors_origins}
    if _normalize_origin(f"{parsed.scheme}://{parsed.netloc}") in origins:
        return
    raise AppError(ErrorCode.VALIDATION_FAILED, "redirect_uri 不在允许范围（回环地址或管理台来源）")


def _parse(value: str) -> urllib.parse.ParseResult | None:
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return parsed


def _normalize_origin(value: str) -> str:
    return value.rstrip("/").lower()


def _callback_url() -> str:
    """本服务的回调地址（IdP 侧需登记）。"""
    settings = get_settings()
    base = (settings.public_base_url or f"http://{settings.api_host}:{settings.api_port}").rstrip("/")
    return f"{base}/api/v1/auth/sso/callback"


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _redirect_error(redirect_uri: str, state: str, code: str, message: str) -> RedirectResponse:
    separator = "&" if "?" in redirect_uri else "?"
    query = urllib.parse.urlencode({"error": code, "error_description": message[:200], "state": state})
    return RedirectResponse(f"{redirect_uri}{separator}{query}", status_code=302)


__all__ = ["router", "validate_redirect_uri"]
