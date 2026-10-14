"""OIDC 协议支撑（design 6.12）：发现文档、authorize URL、token 交换、ID Token 验签、PKCE。

网络访问默认用标准库（urllib）在线程池中执行，避免新增运行时依赖；
ID Token 验签：HS256 走 PyJWT 内置（无需额外依赖），RS256/ES256 需要 `cryptography`（JWKS 缓存）。
测试通过 `get_oidc_http` / `get_oidc_verifier` 依赖注入替身。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import secrets
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Protocol, cast

import jwt

from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode

logger = logging.getLogger(__name__)


class OidcError(AppError):
    def __init__(self, message: str) -> None:
        super().__init__(ErrorCode.VALIDATION_FAILED, message)


# ---------------------------------------------------------------------------
# PKCE 与 URL 构造
# ---------------------------------------------------------------------------


def new_verifier() -> str:
    return secrets.token_urlsafe(48)[:96]


def code_challenge_s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def verify_pkce(verifier: str, challenge: str, method: str = "S256") -> bool:
    if method == "plain":
        return secrets.compare_digest(verifier, challenge)
    return secrets.compare_digest(code_challenge_s256(verifier), challenge)


def build_authorize_url(
    authorization_endpoint: str,
    *,
    client_id: str,
    redirect_uri: str,
    scopes: str,
    state: str,
    nonce: str,
    code_challenge: str,
) -> str:
    query = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": scopes,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    separator = "&" if "?" in authorization_endpoint else "?"
    return f"{authorization_endpoint}{separator}{urllib.parse.urlencode(query)}"


@dataclass
class OidcDiscovery:
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    userinfo_endpoint: str | None
    jwks_uri: str | None
    end_session_endpoint: str | None


# ---------------------------------------------------------------------------
# HTTP 传输
# ---------------------------------------------------------------------------


class OidcHttp(Protocol):
    async def get_json(self, url: str, headers: dict[str, str] | None = None) -> dict[str, Any]: ...
    async def post_form(self, url: str, data: dict[str, str]) -> dict[str, Any]: ...


class UrllibOidcHttp:
    """标准库实现；在线程池中执行以不阻塞事件循环。"""

    def __init__(self, timeout_seconds: int = 15) -> None:
        self._timeout = timeout_seconds

    async def get_json(self, url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
        return await asyncio.to_thread(self._get_json_sync, url, headers or {})

    async def post_form(self, url: str, data: dict[str, str]) -> dict[str, Any]:
        return await asyncio.to_thread(self._post_form_sync, url, data)

    def _get_json_sync(self, url: str, headers: dict[str, str]) -> dict[str, Any]:
        # url 来自管理员配置的身份源 discovery，非用户输入
        request = urllib.request.Request(url, headers=headers, method="GET")  # noqa: S310
        with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310  # nosec B310
            data: dict[str, Any] = json.loads(response.read().decode("utf-8"))
            return data

    def _post_form_sync(self, url: str, data: dict[str, str]) -> dict[str, Any]:
        body = urllib.parse.urlencode(data).encode("ascii")
        # url 为 discovery 中声明的 token 端点（管理员配置的身份源）
        request = urllib.request.Request(  # noqa: S310
            url,
            data=body,
            headers={"content-type": "application/x-www-form-urlencoded", "accept": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._timeout) as response:  # noqa: S310  # nosec B310
            payload: dict[str, Any] = json.loads(response.read().decode("utf-8"))
            return payload


_http: OidcHttp | None = None


def get_oidc_http() -> OidcHttp:
    global _http
    if _http is None:
        _http = UrllibOidcHttp()
    return _http


def set_oidc_http(http: OidcHttp | None) -> None:
    global _http
    _http = http


# ---------------------------------------------------------------------------
# 发现文档与 JWKS 缓存
# ---------------------------------------------------------------------------


@dataclass
class _CacheEntry:
    value: Any
    expires_at: float


_discovery_cache: dict[str, _CacheEntry] = {}
_jwks_cache: dict[str, _CacheEntry] = {}


async def fetch_discovery(http: OidcHttp, issuer_url: str, *, force: bool = False) -> OidcDiscovery:
    url = issuer_url.rstrip("/") + "/.well-known/openid-configuration"
    now = time.monotonic()
    cached = _discovery_cache.get(url)
    if not force and cached and cached.expires_at > now:
        return cast(OidcDiscovery, cached.value)
    try:
        payload = await http.get_json(url)
    except Exception as exc:  # noqa: BLE001 —— 网络/解析错误统一提示
        raise OidcError(f"无法获取 IdP 发现文档（{url}）：{exc}") from exc
    discovery = OidcDiscovery(
        issuer=str(payload.get("issuer") or issuer_url),
        authorization_endpoint=str(payload.get("authorization_endpoint") or ""),
        token_endpoint=str(payload.get("token_endpoint") or ""),
        userinfo_endpoint=payload.get("userinfo_endpoint"),
        jwks_uri=payload.get("jwks_uri"),
        end_session_endpoint=payload.get("end_session_endpoint"),
    )
    if not discovery.authorization_endpoint or not discovery.token_endpoint:
        raise OidcError("IdP 发现文档缺少 authorization_endpoint 或 token_endpoint")
    _discovery_cache[url] = _CacheEntry(discovery, now + get_settings().sso_jwks_cache_seconds)
    return discovery


# ---------------------------------------------------------------------------
# ID Token 验签
# ---------------------------------------------------------------------------


@dataclass
class IdTokenClaims:
    subject: str
    email: str
    email_verified: bool
    name: str | None


class OidcVerifier(Protocol):
    async def verify(
        self,
        *,
        id_token: str,
        discovery: OidcDiscovery,
        client_id: str,
        client_secret: str | None,
        nonce: str,
    ) -> IdTokenClaims: ...


class PyJwtVerifier:
    """HS256（client_secret 作密钥）无需额外依赖；非对称算法需 cryptography 与 JWKS。"""

    async def verify(
        self,
        *,
        id_token: str,
        discovery: OidcDiscovery,
        client_id: str,
        client_secret: str | None,
        nonce: str,
    ) -> IdTokenClaims:
        header = jwt.get_unverified_header(id_token)
        algorithm = str(header.get("alg") or "RS256")
        key: Any | None = None
        if algorithm.startswith("HS"):
            if not client_secret:
                raise OidcError("IdP 使用 HS256 但未配置 client_secret")
            key = client_secret
        else:
            if not discovery.jwks_uri:
                raise OidcError("IdP 未提供 jwks_uri，无法验签 ID Token")
            try:
                from jwt import PyJWKClient
            except ImportError as exc:  # pragma: no cover
                raise OidcError("验签需要安装 cryptography") from exc
            try:
                jwks_client = PyJWKClient(
                    discovery.jwks_uri, cache_keys=True, lifespan=get_settings().sso_jwks_cache_seconds
                )
                signing_key = await asyncio.to_thread(jwks_client.get_signing_key_from_jwt, id_token)
                key = signing_key.key
            except Exception as exc:  # noqa: BLE001 —— 缺 cryptography / JWKS 不可达
                raise OidcError(f"ID Token 验签失败：{exc}") from exc

        try:
            claims = jwt.decode(
                id_token,
                key,
                algorithms=[algorithm],
                audience=client_id,
                issuer=discovery.issuer,
                options={"require": ["exp", "sub"]},
            )
        except jwt.InvalidTokenError as exc:
            raise OidcError(f"ID Token 校验失败：{exc}") from exc

        if nonce and claims.get("nonce") and claims["nonce"] != nonce:
            raise OidcError("ID Token nonce 不匹配")
        return _claims_from(claims)


def _claims_from(claims: dict[str, Any]) -> IdTokenClaims:
    subject = str(claims.get("sub") or "")
    if not subject:
        raise OidcError("ID Token 缺少 sub")
    # 部分 IdP 只在 userinfo 提供邮箱；此处允许为空，由调用方决定是否回退 userinfo
    email = str(claims.get("email") or "")
    return IdTokenClaims(
        subject=subject,
        email=email,
        email_verified=bool(claims.get("email_verified", False)),
        name=claims.get("name") or claims.get("preferred_username"),
    )


_verifier: OidcVerifier | None = None


def get_oidc_verifier() -> OidcVerifier:
    global _verifier
    if _verifier is None:
        _verifier = PyJwtVerifier()
    return _verifier


def set_oidc_verifier(verifier: OidcVerifier | None) -> None:
    global _verifier
    _verifier = verifier


def clear_caches() -> None:
    _discovery_cache.clear()
    _jwks_cache.clear()
