"""测试公共配置。

注意：若在 Windows 上新增使用 psycopg async 的测试，pytest-asyncio 默认的
ProactorEventLoop 会报错，需要为该类测试指定 SelectorEventLoop（参见
huagent.common.runtime.new_event_loop 的做法）。当前测试不访问数据库。
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """单测默认不校验数据库 schema（不依赖 DB）。"""
    monkeypatch.setenv("HUAGENT_SCHEMA_CHECK_ENABLED", "false")
