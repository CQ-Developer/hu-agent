"""集成测试：V0001 DDL 在干净 PG18 上可执行并记录 schema_versions。

默认跳过（需要 Docker）；运行方式：
    HUAGENT_TESTCONTAINERS=1 uv run pytest -m integration -q
"""

from __future__ import annotations

import os
from pathlib import Path

import psycopg
import pytest
from testcontainers.community.postgres import PostgresContainer

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        os.environ.get("HUAGENT_TESTCONTAINERS") != "1",
        reason="需要 Docker；设置 HUAGENT_TESTCONTAINERS=1 后运行",
    ),
]

DDL_FILE = Path(__file__).resolve().parents[3] / "db" / "ddl" / "V0001__init.sql"


def test_v0001_applies_and_records_version() -> None:
    with PostgresContainer("postgres:18-alpine") as postgres:
        url = postgres.get_connection_url().replace("postgresql+psycopg2://", "postgresql://")
        with psycopg.connect(url) as conn:
            conn.execute(DDL_FILE.read_text(encoding="utf-8"))
            rows = conn.execute("SELECT version FROM schema_versions ORDER BY version").fetchall()

    assert rows == [("V0001",)]
