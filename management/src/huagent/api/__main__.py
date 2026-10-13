"""API 进程入口：uv run huagent-api。"""

from __future__ import annotations

import asyncio
import logging

import uvicorn

from huagent.common.config import get_settings
from huagent.common.runtime import new_event_loop


def main() -> None:
    settings = get_settings()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    # 用 Server.serve() + 自定义 loop_factory，避免 Windows 上 Psycopg 与
    # ProactorEventLoop 不兼容（见 huagent.common.runtime）。
    config = uvicorn.Config(
        "huagent.api.app:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level="info",
    )
    server = uvicorn.Server(config)
    asyncio.run(server.serve(), loop_factory=new_event_loop)


if __name__ == "__main__":
    main()
