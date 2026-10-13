"""主密钥加密（design 6.12.2）：AES-GCM 保护 IdP client_secret 与服务端 PKCE verifier。

主密钥来自 `HUAGENT_MASTER_KEY`（Base64 或 hex 的 32 字节）；未配置时退化为从
`jwt_secret` 派生（仅本地开发，启动时告警一次）。

AES-GCM 需要 `cryptography` 包；未安装时创建/使用身份源会返回明确错误。
测试通过 `get_secret_cipher` 依赖注入替身，不依赖该包。
"""

from __future__ import annotations

import base64
import hashlib
import logging
from typing import Protocol

from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode

logger = logging.getLogger(__name__)

_warned = False


class SecretCipher(Protocol):
    def encrypt(self, plaintext: str) -> str: ...
    def decrypt(self, token: str) -> str: ...


def resolve_master_key() -> bytes:
    settings = get_settings()
    raw = settings.master_key.strip()
    if raw:
        for decoder in (base64.b64decode, bytes.fromhex):
            try:
                key = decoder(raw)
                if len(key) == 32:
                    return key
            except Exception as exc:  # noqa: BLE001 —— 尝试下一种解码方式
                logger.debug("master key 解码尝试失败：%s", exc)
                continue
        raise AppError(ErrorCode.INTERNAL, "HUAGENT_MASTER_KEY 必须是 32 字节的 Base64 或 hex")
    global _warned
    if not _warned:
        logger.warning("未配置 HUAGENT_MASTER_KEY，退化为从 jwt_secret 派生（仅限本地开发）")
        _warned = True
    return hashlib.sha256(f"huagent-master:{settings.jwt_secret}".encode()).digest()


class AesGcmCipher:
    """密文格式：base64(nonce(12) || ciphertext || tag(16))。"""

    def __init__(self, key: bytes | None = None) -> None:
        try:
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        except ImportError as exc:  # pragma: no cover —— 仅在缺少依赖时触发
            raise AppError(
                ErrorCode.INTERNAL,
                "SSO 需要服务端安装 cryptography（AES-GCM 与 RS256 验签）："
                "请在 management 目录执行 uv add cryptography",
            ) from exc
        import os

        self._aesgcm = AESGCM(key or resolve_master_key())
        self._os = os

    def encrypt(self, plaintext: str) -> str:
        nonce = self._os.urandom(12)
        sealed = self._aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
        return base64.b64encode(nonce + sealed).decode("ascii")

    def decrypt(self, token: str) -> str:
        raw = base64.b64decode(token)
        nonce, sealed = raw[:12], raw[12:]
        try:
            plaintext: bytes = self._aesgcm.decrypt(nonce, sealed, None)
            return plaintext.decode("utf-8")
        except Exception as exc:  # noqa: BLE001 —— 密钥不匹配或密文损坏
            raise AppError(ErrorCode.INTERNAL, "client_secret 解密失败（主密钥是否变更？）") from exc


_cipher: SecretCipher | None = None


def get_secret_cipher() -> SecretCipher:
    """FastAPI 依赖；测试可覆盖为内存替身。"""
    global _cipher
    if _cipher is None:
        _cipher = AesGcmCipher()
    return _cipher


def set_secret_cipher(cipher: SecretCipher | None) -> None:
    """测试/运行时替换（如注入 KMS）。"""
    global _cipher
    _cipher = cipher
