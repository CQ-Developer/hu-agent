"""worker 进程入口：uv run huagent-worker。"""

from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from huagent.common.runtime import new_event_loop
from huagent.worker.jobs import heartbeat

logger = logging.getLogger("huagent.worker")


async def run() -> None:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(heartbeat, "interval", minutes=5, id="heartbeat", max_instances=1)
    scheduler.start()
    logger.info("worker started")
    try:
        await asyncio.Event().wait()
    finally:
        scheduler.shutdown(wait=False)


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(run(), loop_factory=new_event_loop)


if __name__ == "__main__":
    main()
