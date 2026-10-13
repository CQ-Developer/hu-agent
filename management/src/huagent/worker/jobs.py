"""定时任务集合。

阶段 6 在此补充：用量聚合、分区维护、快照清理、保留策略、对账。
每个任务需幂等；多实例防重使用 PostgreSQL advisory lock + job_runs（design 6.11）。
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def heartbeat() -> None:
    """阶段 0 占位任务：仅记录日志，验证调度器可用。"""
    logger.info("worker heartbeat")
