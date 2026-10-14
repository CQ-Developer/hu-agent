"""登录限流与账号锁定（design 6.10.1）：IP 维度 10/min，单账号 5 次失败递增锁 1/5/15 分钟。

优先使用 Redis（多实例共享）；连接失败时降级为进程内存（本地/测试），
生产可通过 HUAGENT_RATE_LIMIT_STRICT=true 让 Redis 不可用时直接拒绝登录。
"""

from __future__ import annotations

import logging
import math
import time
from typing import Protocol

from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.common.metrics import LOGIN_ATTEMPTS

logger = logging.getLogger(__name__)

LOCK_STEPS_SECONDS: tuple[int, ...] = (60, 300, 900)
FAIL_WINDOW_SECONDS = 24 * 3600


class RateBackend(Protocol):
    async def incr(self, key: str, ttl_seconds: int) -> int: ...
    async def set(self, key: str, value: str, ttl_seconds: int) -> None: ...
    async def ttl(self, key: str) -> int: ...
    async def delete(self, key: str) -> None: ...


class MemoryBackend:
    """进程内实现；单实例部署可用，重启后计数清零。"""

    def __init__(self) -> None:
        self._counters: dict[str, tuple[int, float]] = {}
        self._values: dict[str, tuple[str, float]] = {}
        self._cleanup_at = 0.0

    def _cleanup(self, now: float) -> None:
        if now < self._cleanup_at:
            return
        self._cleanup_at = now + 60
        for key, (_, expires) in list(self._counters.items()):
            if expires <= now:
                del self._counters[key]
        for key, (_, expires) in list(self._values.items()):
            if expires <= now:
                del self._values[key]

    async def incr(self, key: str, ttl_seconds: int) -> int:
        now = time.monotonic()
        self._cleanup(now)
        count, expires = self._counters.get(key, (0, now + ttl_seconds))
        if expires <= now:
            count, expires = 0, now + ttl_seconds
        count += 1
        self._counters[key] = (count, expires)
        return count

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        self._values[key] = (value, time.monotonic() + ttl_seconds)

    async def ttl(self, key: str) -> int:
        entry = self._values.get(key)
        if entry is None:
            return 0
        remaining = entry[1] - time.monotonic()
        return max(0, math.ceil(remaining))

    async def delete(self, key: str) -> None:
        self._values.pop(key, None)
        self._counters.pop(key, None)


class RedisBackend:
    def __init__(self, client: object) -> None:
        self._client = client

    async def incr(self, key: str, ttl_seconds: int) -> int:
        pipe = self._client.pipeline()  # type: ignore[attr-defined]
        pipe.incr(key)
        pipe.expire(key, ttl_seconds, nx=True)
        results = await pipe.execute()
        return int(results[0])

    async def set(self, key: str, value: str, ttl_seconds: int) -> None:
        await self._client.set(key, value, ex=ttl_seconds)  # type: ignore[attr-defined]

    async def ttl(self, key: str) -> int:
        value = await self._client.ttl(key)  # type: ignore[attr-defined]
        return int(value) if value and int(value) > 0 else 0

    async def delete(self, key: str) -> None:
        await self._client.delete(key)  # type: ignore[attr-defined]


class LoginGuard:
    """登录限流器；`ip_limit`/`fail_threshold` 默认取配置。"""

    def __init__(
        self,
        backend: RateBackend,
        *,
        ip_limit: int | None = None,
        ip_window_seconds: int | None = None,
        fail_threshold: int | None = None,
    ) -> None:
        settings = get_settings()
        self._backend = backend
        self._ip_limit = ip_limit or settings.login_ip_limit
        self._ip_window = ip_window_seconds or settings.login_ip_window_seconds
        self._fail_threshold = fail_threshold or settings.login_fail_threshold

    async def check_ip(self, ip: str) -> None:
        count = await self._backend.incr(f"rl:login:ip:{ip}", self._ip_window)
        if count > self._ip_limit:
            LOGIN_ATTEMPTS.inc(result="locked_ip")
            raise AppError(
                ErrorCode.RATE_LIMITED,
                "登录请求过于频繁，请稍后再试",
                headers={"Retry-After": str(self._ip_window)},
            )

    async def check_account(self, email: str) -> None:
        remaining = await self._backend.ttl(f"rl:login:lock:{email}")
        if remaining > 0:
            minutes = max(1, math.ceil(remaining / 60))
            LOGIN_ATTEMPTS.inc(result="locked_account")
            raise AppError(
                ErrorCode.RATE_LIMITED,
                f"账号已临时锁定，请约 {minutes} 分钟后重试",
                details={"lockedSeconds": remaining},
                headers={"Retry-After": str(remaining)},
            )

    async def on_failure(self, email: str) -> None:
        count = await self._backend.incr(f"rl:login:fail:{email}", FAIL_WINDOW_SECONDS)
        if count % self._fail_threshold == 0:
            level = min(count // self._fail_threshold, len(LOCK_STEPS_SECONDS)) - 1
            await self._backend.set(f"rl:login:lock:{email}", "1", LOCK_STEPS_SECONDS[level])
            logger.warning("账号 %s 连续失败 %d 次，锁定 %d 秒", email, count, LOCK_STEPS_SECONDS[level])

    async def on_success(self, email: str) -> None:
        await self._backend.delete(f"rl:login:fail:{email}")
        await self._backend.delete(f"rl:login:lock:{email}")


_guard: LoginGuard | None = None


async def get_login_guard() -> LoginGuard:
    """进程内单例；Redis 可用时用 Redis，否则降级内存（strict 模式直接拒绝）。"""
    global _guard
    if _guard is not None:
        return _guard

    settings = get_settings()
    try:
        from redis.asyncio import Redis

        client = Redis.from_url(settings.redis_url, socket_connect_timeout=1, socket_timeout=1)
        await client.ping()
        _guard = LoginGuard(RedisBackend(client))
        logger.info("登录限流使用 Redis：%s", settings.redis_url)
        return _guard
    except Exception as exc:  # noqa: BLE001 —— 降级路径需要兜住任何连接错误
        if settings.rate_limit_strict:
            logger.error("Redis 不可用且开启 strict 模式，拒绝登录：%s", exc)
            raise AppError(ErrorCode.INTERNAL, "登录服务暂不可用（限流组件未就绪）") from exc
        logger.warning("Redis 不可用，登录限流降级为进程内存：%s", exc)
        _guard = LoginGuard(MemoryBackend())
        return _guard


def reset_login_guard() -> None:
    """测试用：清空单例。"""
    global _guard
    _guard = None
