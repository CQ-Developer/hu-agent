"""worker 进程入口：uv run huagent-worker。"""

from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from huagent.common.runtime import new_event_loop
from huagent.worker.jobs import (
    heartbeat,
    job_aggregate_usage,
    job_cleanup_snapshots,
    job_expire_invitations,
    job_maintain_partitions,
    job_remind_approvals,
)

logger = logging.getLogger("huagent.worker")


async def run() -> None:
    # 启动时先补偿一次：服务停机期间积压的用量与分区（design 6.11 任务幂等）
    await job_aggregate_usage()
    await job_maintain_partitions()

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(heartbeat, "interval", minutes=5, id="heartbeat", max_instances=1)
    # design 6.11：用量聚合每小时；分区维护每日 02:00；快照清理每日 03:00；邀请/审批每小时
    scheduler.add_job(job_aggregate_usage, "interval", minutes=60, id="usage.aggregate", max_instances=1)
    scheduler.add_job(job_maintain_partitions, "cron", hour=2, minute=0, id="usage.partitions", max_instances=1)
    scheduler.add_job(job_cleanup_snapshots, "cron", hour=3, minute=0, id="snapshot.cleanup", max_instances=1)
    scheduler.add_job(job_expire_invitations, "interval", minutes=60, id="invitation.expire", max_instances=1)
    scheduler.add_job(job_remind_approvals, "interval", minutes=60, id="approval.remind", max_instances=1)
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
