"""登录限流与账号锁定单测（design 6.10.1）。"""

from __future__ import annotations

import pytest

from huagent.common.errors import AppError, ErrorCode
from huagent.common.ratelimit import LOCK_STEPS_SECONDS, LoginGuard, MemoryBackend


async def test_ip_limit_blocks_after_threshold() -> None:
    guard = LoginGuard(MemoryBackend(), ip_limit=3, ip_window_seconds=60, fail_threshold=5)
    for _ in range(3):
        await guard.check_ip("1.2.3.4")
    with pytest.raises(AppError) as exc:
        await guard.check_ip("1.2.3.4")
    assert exc.value.code == ErrorCode.RATE_LIMITED
    assert exc.value.headers["Retry-After"] == "60"

    # 其他 IP 不受影响
    await guard.check_ip("5.6.7.8")


async def test_account_locks_in_escalating_steps() -> None:
    guard = LoginGuard(MemoryBackend(), ip_limit=1000, fail_threshold=5)
    email = "user@example.com"

    for _ in range(4):
        await guard.on_failure(email)
    await guard.check_account(email)  # 未锁定

    await guard.on_failure(email)  # 第 5 次
    with pytest.raises(AppError) as first:
        await guard.check_account(email)
    assert first.value.code == ErrorCode.RATE_LIMITED
    assert first.value.details["lockedSeconds"] == LOCK_STEPS_SECONDS[0]


async def test_success_resets_failures() -> None:
    guard = LoginGuard(MemoryBackend(), ip_limit=1000, fail_threshold=3)
    email = "user@example.com"
    await guard.on_failure(email)
    await guard.on_failure(email)
    await guard.on_success(email)
    await guard.on_failure(email)
    await guard.check_account(email)  # 计数已清零，不应触发锁定
