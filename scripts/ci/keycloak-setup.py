#!/usr/bin/env python3
"""通过 Keycloak Admin REST 准备 CI 用的 realm/client/用户（幂等）。

不依赖 kcadm.sh，纯 HTTP，便于在 CI 里对 docker run 起的 Keycloak 使用。

用法：`uv run --project management python scripts/ci/keycloak-setup.py --base http://127.0.0.1:8100`
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

REALM = "huagent"
CLIENT_ID = "hu-agent"
CLIENT_SECRET = "hu-agent-secret"
REDIRECT_URI = "http://127.0.0.1:8080/api/v1/auth/sso/callback"
USER_EMAIL = "sso-user@example.com"
USER_PASSWORD = "Sso-Passphrase-2026"


def call(
    url: str,
    *,
    token: str | None = None,
    method: str = "GET",
    body: Any = None,
    form: dict[str, str] | None = None,
) -> tuple[int, Any]:
    data: bytes | None = None
    request = urllib.request.Request(url, method=method)  # noqa: S310
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        request.add_header("content-type", "application/x-www-form-urlencoded")
    elif body is not None:
        data = json.dumps(body).encode()
        request.add_header("content-type", "application/json")
    if data is not None:
        request.data = data
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            payload = response.read().decode()
            return response.status, json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        payload = error.read().decode()
        try:
            return error.code, json.loads(payload or "{}")
        except json.JSONDecodeError:
            return error.code, {"raw": payload[:200]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://127.0.0.1:8100")
    parser.add_argument("--admin", default="admin")
    parser.add_argument("--admin-password", default="admin")
    parser.add_argument("--api", default="http://127.0.0.1:8080")
    args = parser.parse_args()
    base = args.base.rstrip("/")

    status, token_body = call(
        f"{base}/realms/master/protocol/openid-connect/token",
        method="POST",
        form={
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": args.admin,
            "password": args.admin_password,
        },
    )
    assert status == 200, token_body
    token = token_body["access_token"]
    print("[keycloak] 管理员令牌获取成功")

    status, _ = call(f"{base}/admin/realms", token=token, method="POST", body={"realm": REALM, "enabled": True})
    print(f"[keycloak] 创建 realm {REALM}：{status}（409 表示已存在）")

    status, clients = call(f"{base}/admin/realms/{REALM}/clients?clientId={CLIENT_ID}", token=token)
    assert status == 200, clients
    if not clients:
        status, _ = call(
            f"{base}/admin/realms/{REALM}/clients",
            token=token,
            method="POST",
            body={
                "clientId": CLIENT_ID,
                "enabled": True,
                "publicClient": False,
                "secret": CLIENT_SECRET,
                "standardFlowEnabled": True,
                "redirectUris": [REDIRECT_URI],
            },
        )
        assert status in (201, 204), status
        print(f"[keycloak] 创建 client {CLIENT_ID}")
    else:
        print(f"[keycloak] client {CLIENT_ID} 已存在")

    status, users = call(
        f"{base}/admin/realms/{REALM}/users?email={urllib.parse.quote(USER_EMAIL)}", token=token
    )
    assert status == 200, users
    if not users:
        status, _ = call(
            f"{base}/admin/realms/{REALM}/users",
            token=token,
            method="POST",
            body={
                "username": USER_EMAIL,
                "email": USER_EMAIL,
                "emailVerified": True,
                "enabled": True,
                "firstName": "SSO",
                "lastName": "User",
            },
        )
        assert status in (201, 204), status
        status, users = call(
            f"{base}/admin/realms/{REALM}/users?email={urllib.parse.quote(USER_EMAIL)}", token=token
        )
        print("[keycloak] 创建测试用户")
    user_id = users[0]["id"]
    status, _ = call(
        f"{base}/admin/realms/{REALM}/users/{user_id}/reset-password",
        token=token,
        method="PUT",
        body={"type": "password", "value": USER_PASSWORD, "temporary": False},
    )
    assert status in (204, 200), status
    print(f"[keycloak] 测试用户密码已设置（{USER_EMAIL}）")

    status, discovery = call(f"{base}/realms/{REALM}/.well-known/openid-configuration")
    assert status == 200, discovery
    print(f"[keycloak] 发现文档可用：{discovery['issuer']}")
    print(json.dumps({"issuer": discovery["issuer"], "clientId": CLIENT_ID, "clientSecret": CLIENT_SECRET}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
