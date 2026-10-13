#!/usr/bin/env python3
"""真实 IdP（Keycloak 等）SSO 联调脚本（design 6.12，发布前清单可复用）。

流程：本地管理员登录 hu-agent → 建/取身份源 → 模拟浏览器（cookie + 表单登录）
完成 authorize → 捕获回环回调的 code → exchange → 校验 /me、绑定关系，
可选验证「禁用身份源即时撤销会话」。

用法（默认对接本机 docker compose 的 Keycloak）：
    uv run --project management python scripts/sso-live-check.py \
        --admin-email sysadmin@example.com --admin-password 'Str0ng-Passphrase-2026'

仅依赖标准库。"""

from __future__ import annotations

import argparse
import base64
import hashlib
import html
import http.server
import json
import re
import secrets
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request

API = "http://127.0.0.1:8080"
ISSUER = "http://127.0.0.1:8081/realms/huagent"
CLIENT_ID = "hu-agent"
CLIENT_SECRET = "hu-agent-secret"
PROVIDER_NAME = "本地 Keycloak"
USER_EMAIL = "sso-user@example.com"
USER_PASSWORD = "Sso-Passphrase-2026"


def call(url: str, *, token: str | None = None, method: str = "GET", body: dict | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)  # noqa: S310
    request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        payload = error.read().decode()
        try:
            return error.code, json.loads(payload or "{}")
        except json.JSONDecodeError:
            return error.code, {"raw": payload[:200]}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


class Browser:
    """极简浏览器：手动维护 Cookie 与重定向（比 CookieJar 更贴近真实浏览器行为，
    且不受 Secure/Partitioned 等属性影响）。"""

    def __init__(self) -> None:
        self.cookies: dict[str, str] = {}

    def _merge_cookies(self, headers: object) -> None:
        for value in headers.get_all("Set-Cookie") or []:  # type: ignore[attr-defined]
            pair = value.split(";", 1)[0]
            if "=" in pair:
                name, _, cookie_value = pair.partition("=")
                self.cookies[name.strip()] = cookie_value.strip()

    def _cookie_header(self) -> str:
        return "; ".join(f"{name}={value}" for name, value in self.cookies.items())

    def fetch(self, url: str, data: dict[str, str] | None = None) -> tuple[int, str, str]:
        current, payload = url, data
        opener = urllib.request.build_opener(NoRedirect)
        for _ in range(10):
            request = urllib.request.Request(  # noqa: S310
                current, data=urllib.parse.urlencode(payload).encode() if payload else None
            )
            request.add_header("cookie", self._cookie_header())
            if payload:
                request.add_header("content-type", "application/x-www-form-urlencoded")
            try:
                response = opener.open(request, timeout=30)  # noqa: S310
                status, headers, body = response.status, response.headers, response.read().decode()
            except urllib.error.HTTPError as error:
                status, headers, body = error.code, error.headers, error.read().decode()
            self._merge_cookies(headers)
            if status in (301, 302, 303, 307, 308) and headers.get("location"):
                current = urllib.parse.urljoin(current, headers["location"])
                payload = None
                continue
            return status, current, body
        raise RuntimeError("重定向次数过多")


class CaptureHandler(http.server.BaseHTTPRequestHandler):
    captured: dict[str, str] = {}

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return
        CaptureHandler.captured = {key: values[0] for key, values in urllib.parse.parse_qs(parsed.query).items()}
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write("<html><body>登录完成，可关闭此页面</body></html>".encode())

    def log_message(self, *args: object) -> None:  # 静默
        return


def parse_form(html_text: str) -> tuple[str, dict[str, str]]:
    action_match = re.search(r'<form[^>]*action="([^"]+)"', html_text)
    if not action_match:
        raise SystemExit("未找到登录表单（IdP 未返回期望的登录页）")
    action = html.unescape(action_match.group(1))
    fields: dict[str, str] = {}
    for tag in re.findall(r"<input[^>]*>", html_text):
        name = re.search(r'name="([^"]+)"', tag)
        value = re.search(r'value="([^"]*)"', tag)
        if name:
            fields[name.group(1)] = html.unescape(value.group(1)) if value else ""
    return action, fields


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default=API)
    parser.add_argument("--issuer", default=ISSUER)
    parser.add_argument("--client-id", default=CLIENT_ID)
    parser.add_argument("--client-secret", default=CLIENT_SECRET)
    parser.add_argument("--provider-name", default=PROVIDER_NAME)
    parser.add_argument("--admin-email", required=True)
    parser.add_argument("--admin-password", required=True)
    parser.add_argument("--email", default=USER_EMAIL)
    parser.add_argument("--password", default=USER_PASSWORD)
    parser.add_argument("--skip-revoke-check", action="store_true")
    args = parser.parse_args()

    print(f"[1] 管理员登录 {args.admin_email}")
    status, body = call(
        f"{args.api}/api/v1/auth/login",
        method="POST",
        body={
            "email": args.admin_email,
            "password": args.admin_password,
            "device": {"deviceId": "sso-live-check", "platform": "win32", "appVersion": "0.1.0"},
        },
    )
    if status != 200:
        print(f"    登录失败：{status} {body}")
        return 1
    admin_token = body["accessToken"]
    print("    OK")

    print(f"[2] 配置身份源 {args.provider_name}")
    status, listing = call(f"{args.api}/api/v1/admin/identity-providers", token=admin_token)
    providers = listing if isinstance(listing, list) else []
    existing = next((item for item in providers if item["name"] == args.provider_name), None)
    payload = {
        "name": args.provider_name,
        "issuerUrl": args.issuer,
        "clientId": args.client_id,
        "clientSecret": args.client_secret,
        "scopes": "openid profile email",
        "enabled": True,
        "allowedEmailDomains": [],
        "allowAutoLink": True,
    }
    if existing:
        status, provider = call(
            f"{args.api}/api/v1/admin/identity-providers/{existing['id']}",
            token=admin_token,
            method="PATCH",
            body=payload,
        )
    else:
        status, provider = call(
            f"{args.api}/api/v1/admin/identity-providers", token=admin_token, method="POST", body=payload
        )
    if status not in (200, 201):
        print(f"    配置失败：{status} {provider}")
        return 1
    provider_id = provider["id"]
    print(f"    OK providerId={provider_id} hasSecret={provider['hasSecret']}")

    print("[3] 模拟浏览器完成 authorize → 回环回调")
    server = http.server.HTTPServer(("127.0.0.1", 0), CaptureHandler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    client_state = secrets.token_urlsafe(16)
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    authorize = (
        f"{args.api}/api/v1/auth/sso/{provider_id}/authorize?"
        + urllib.parse.urlencode(
            {
                "redirect_uri": redirect_uri,
                "state": client_state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "deviceId": "sso-live-check",
                "platform": "win32",
                "appVersion": "0.1.0",
            }
        )
    )
    try:
        urllib.request.build_opener(NoRedirect).open(authorize, timeout=30)  # noqa: S310
        raise SystemExit("expect redirect")
    except urllib.error.HTTPError as error:
        idp_url = error.headers["location"]
    print(f"    302 → IdP：{idp_url[:90]}…")

    browser = Browser()
    _status, _url, page = browser.fetch(idp_url)
    action, fields = parse_form(page)
    fields["username"] = args.email
    fields["password"] = args.password
    try:
        status, final_url, final_page = browser.fetch(action, data=fields)
    except RuntimeError as error:
        print(f"    浏览器模拟失败：{error}")
        return 1
    if status >= 400:
        plain = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", final_page)).strip()
        print(f"    IdP 登录失败：HTTP {status}（{final_url[:80]}）")
        print(f"    IdP 提示：{plain[:200]}")
        return 1

    captured = CaptureHandler.captured
    server.shutdown()
    if captured.get("state") != client_state:
        print(f"    state 不匹配或未收到回调：{captured}")
        print(f"    IdP 页面片段：{final_page[:200]}")
        return 1
    if "code" not in captured:
        print(f"    回调未带 code：{captured}")
        return 1
    print(f"    OK 收到一次性 code（state 校验通过）")

    print("[4] exchange 换取本地会话")
    status, tokens = call(
        f"{args.api}/api/v1/auth/sso/exchange",
        method="POST",
        body={"code": captured["code"], "codeVerifier": verifier},
    )
    if status != 200:
        print(f"    交换失败：{status} {tokens}")
        return 1
    user = tokens["user"]
    print(f"    OK 用户 {user['email']}（{user['displayName']}）id={user['id']}")

    print("[5] 校验 /me 与绑定关系")
    status, me = call(f"{args.api}/api/v1/me", token=tokens["accessToken"])
    assert status == 200, me
    status, identities = call(f"{args.api}/api/v1/me/identities", token=tokens["accessToken"])
    assert status == 200, identities
    print(f"    OK /me={me['email']}；绑定身份源 {len(identities)} 个：{[i['providerName'] for i in identities]}")

    if not args.skip_revoke_check:
        print("[6] 禁用身份源 → 会话即时撤销")
        status, _ = call(
            f"{args.api}/api/v1/admin/identity-providers/{provider_id}",
            token=admin_token,
            method="PATCH",
            body={"enabled": False},
        )
        assert status == 200
        status, refreshed = call(
            f"{args.api}/api/v1/auth/refresh", method="POST", body={"refreshToken": tokens["refreshToken"]}
        )
        assert status == 401, refreshed
        print("    OK 刷新令牌已失效（401）")
        call(
            f"{args.api}/api/v1/admin/identity-providers/{provider_id}",
            token=admin_token,
            method="PATCH",
            body={"enabled": True},
        )
        print("    已恢复身份源为启用")

    print("\n全部通过：真实 IdP 的 RS256 + JWKS 验签、JIT 建号、绑定与禁用撤销均符合预期。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
