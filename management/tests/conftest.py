"""测试公共配置。"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """单测默认不校验数据库 schema（不依赖 DB）。"""
    monkeypatch.setenv("HUAGENT_SCHEMA_CHECK_ENABLED", "false")
