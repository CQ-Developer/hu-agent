"""worker 进程入口：uv run huagent-worker。"""

from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from huagent.common.runtime import new_event_loop
from huagent.worker import schedule
from huagent.worker.jobs import job_aggregate_usage, job_maintain_partitions

logger = logging.getLogger("huagent.worker")


async def run() -> None:
    # 启动时先补偿一次：服务停机期间积压的用量与分区（design 6.11 任务幂等）
    await job_aggregate_usage()
    await job_maintain_partitions()

    scheduler = AsyncIOScheduler(timezone="UTC")
    # 任务表与「新鲜度预算」都定义在 worker/schedule.py（告警阈值由周期推导）
    schedule.register(scheduler)
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
