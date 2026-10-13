"""API 进程入口：uv run huagent-api。"""

from __future__ import annotations

import logging

import uvicorn

from huagent.common.config import get_settings


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    uvicorn.run(
        "huagent.api.app:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
