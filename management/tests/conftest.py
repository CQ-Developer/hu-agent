"""测试公共配置。

- 单测默认不校验数据库 schema（不依赖 DB）。
- Windows 下 psycopg async 需要 SelectorEventLoop（ProactorEventLoop 不支持）；
  通过 pytest-asyncio 的 loop factory hook 统一选择事件循环。
"""

from __future__ import annotations

import asyncio
import selectors
import sys
from collections.abc import Iterator
from typing import Any

import pytest


@pytest.fixture(autouse=True)
def _isolate_settings(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """单测默认不校验数据库 schema（不依赖 DB）。"""
    monkeypatch.setenv("HUAGENT_SCHEMA_CHECK_ENABLED", "false")
    yield


def pytest_asyncio_loop_factories(config: Any, item: Any) -> dict[str, Any] | None:
    """Windows 下返回 SelectorEventLoop 工厂（psycopg async 要求）。"""
    del config, item
    if sys.platform != "win32":
        return None

    def selector_factory() -> asyncio.AbstractEventLoop:
        return asyncio.SelectorEventLoop(selectors.SelectSelector())

    return {"selector": selector_factory}
