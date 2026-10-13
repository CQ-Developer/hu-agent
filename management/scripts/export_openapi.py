"""导出 OpenAPI 契约（design 6.9）：uv run python scripts/export_openapi.py

产物写入仓库根目录 openapi/openapi.json，供管理台与客户端生成 TypeScript 调用代码。
"""

from __future__ import annotations

import json
from pathlib import Path

from huagent.api.app import create_app

REPO_ROOT = Path(__file__).resolve().parents[2]


def main() -> None:
    spec = create_app().openapi()
    out = REPO_ROOT / "openapi" / "openapi.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(spec, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已生成 {out}")


if __name__ == "__main__":
    main()
