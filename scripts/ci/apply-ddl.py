#!/usr/bin/env python3
"""按编号顺序应用 db/ddl/V*.sql（CI 用；本地请用 scripts/ddl-apply.sh）。

依赖 psycopg（management 依赖内）：`uv run --project management python scripts/ci/apply-ddl.py`
环境变量 `HUAGENT_DATABASE_URL` 可用同步 URL（postgresql://…）。
"""

from __future__ import annotations

import os
import pathlib
import sys

import psycopg

REPO = pathlib.Path(__file__).resolve().parents[2]


def main() -> int:
    url = os.environ.get("HUAGENT_DATABASE_URL", "postgresql://huagent:huagent_dev@localhost:5432/huagent")
    url = url.replace("postgresql+psycopg://", "postgresql://")
    files = sorted((REPO / "db" / "ddl").glob("V*.sql"))
    if not files:
        print("未找到 DDL 文件", file=sys.stderr)
        return 1
    with psycopg.connect(url) as conn:
        for path in files:
            applied = conn.execute(
                "SELECT to_regclass('public.schema_versions') IS NOT NULL"
            ).fetchone()
            if applied and applied[0]:
                version = path.name.split("_", 1)[0]
                exists = conn.execute(
                    "SELECT count(*) FROM schema_versions WHERE version = %s", (version,)
                ).fetchone()
                if exists and exists[0]:
                    print(f"跳过 {path.name}（已应用）")
                    continue
            print(f"应用 {path.name}")
            conn.execute(path.read_text(encoding="utf-8"))
    print("DDL 全部应用完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
