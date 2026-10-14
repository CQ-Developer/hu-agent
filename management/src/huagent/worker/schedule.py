"""定时任务表（design 6.11）：worker 注册调度的唯一来源，同时导出「新鲜度预算」。

为什么要集中：告警规则 `HuAgentWorkerJobStale` 需要知道「某任务多久没成功完成才算异常」。
若把阈值写死在告警里（例如统一 2 小时），每日 cron 任务（快照清理、分区维护、PII 清理）
在两次执行之间必然长时间没有新时间戳，会持续误报，直到运维把告警静音——
这等于失去对 worker 的监控。因此预算由任务周期推导，并作为指标
`huagent_job_staleness_budget_seconds` 导出，告警只做「实际间隔 > 预算」的比较。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from huagent.worker.jobs import (
    heartbeat,
    job_aggregate_usage,
    job_cleanup_snapshots,
    job_expire_invitations,
    job_maintain_partitions,
    job_prune_usage_daily,
    job_purge_deleted_users,
    job_remind_approvals,
)

if TYPE_CHECKING:  # pragma: no cover - 仅类型标注，避免 API 进程无谓引入 APScheduler
    from apscheduler.schedulers.asyncio import AsyncIOScheduler

Handler = Callable[[], Awaitable[None]]
Kind = Literal["interval", "cron"]

_DAY_SECONDS = 24 * 3600
_MIN_BUDGET_SECONDS = 15 * 60


@dataclass(frozen=True, slots=True)
class JobSpec:
    """一个定时任务：调度方式 + 执行体。预算由周期推导，不手工维护。"""

    id: str
    handler: Handler
    kind: Kind
    minutes: int | None = None  # kind="interval"
    hour: int | None = None  # kind="cron"（UTC）
    minute: int | None = None  # kind="cron"

    @property
    def budget_seconds(self) -> int:
        """距上次成功完成多久即视为异常。

        - interval 任务：3 倍周期（下限 15 分钟）——允许一次失败与一次重试；
        - cron 任务：26 小时——每日一次，外加 2 小时余量（启动补偿、慢任务、夏令时）。
        """
        if self.kind == "interval":
            if self.minutes is None:
                raise ValueError(f"{self.id}: interval 任务必须给出 minutes")
            return max(self.minutes * 60 * 3, _MIN_BUDGET_SECONDS)
        return _DAY_SECONDS + 2 * 3600


JOBS: tuple[JobSpec, ...] = (
    JobSpec("heartbeat", heartbeat, "interval", minutes=5),
    # design 6.11：用量聚合每小时；分区维护每日 02:00；快照清理每日 03:00；邀请/审批每小时
    JobSpec("usage.aggregate", job_aggregate_usage, "interval", minutes=60),
    JobSpec("usage.partitions", job_maintain_partitions, "cron", hour=2, minute=0),
    JobSpec("snapshot.cleanup", job_cleanup_snapshots, "cron", hour=3, minute=0),
    JobSpec("invitation.expire", job_expire_invitations, "interval", minutes=60),
    JobSpec("approval.remind", job_remind_approvals, "interval", minutes=60),
    # design 6.10.5：注销宽限期到点后清理 PII；日聚合按保留策略清理
    JobSpec("user.purge", job_purge_deleted_users, "cron", hour=4, minute=0),
    JobSpec("usage.daily.prune", job_prune_usage_daily, "cron", hour=4, minute=30),
)

#: 供指标端点导出（api/routes/system.py）与告警规则使用
STALENESS_BUDGET_SECONDS: dict[str, int] = {spec.id: spec.budget_seconds for spec in JOBS}


def register(scheduler: AsyncIOScheduler, jobs: tuple[JobSpec, ...] = JOBS) -> None:
    """把任务表注册进调度器（每次启动只调用一次）。"""
    for spec in jobs:
        if spec.kind == "interval":
            scheduler.add_job(spec.handler, "interval", id=spec.id, minutes=spec.minutes, max_instances=1)
        else:
            scheduler.add_job(
                spec.handler, "cron", id=spec.id, hour=spec.hour, minute=spec.minute, max_instances=1
            )
