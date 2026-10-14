"""任务表与「新鲜度预算」测试。

预算决定了 HuAgentWorkerJobStale 是否可用：写死阈值会让每日 cron 任务持续误报，
所以这里锁定「预算必须由周期推导，且每日任务不得低于 24 小时」这一契约。
"""

from __future__ import annotations

import pytest

from huagent.worker.schedule import JOBS, STALENESS_BUDGET_SECONDS, register

DAY = 24 * 3600


def test_job_ids_are_unique() -> None:
    ids = [spec.id for spec in JOBS]
    assert len(ids) == len(set(ids))


def test_every_job_has_a_budget() -> None:
    assert set(STALENESS_BUDGET_SECONDS) == {spec.id for spec in JOBS}
    assert all(budget > 0 for budget in STALENESS_BUDGET_SECONDS.values())


def test_interval_budget_is_three_periods_with_floor() -> None:
    # 心跳每 5 分钟：3 倍周期（15 分钟）即下限
    assert STALENESS_BUDGET_SECONDS["heartbeat"] == 15 * 60
    # 每小时任务：3 小时，允许一次失败与一次重试
    assert STALENESS_BUDGET_SECONDS["usage.aggregate"] == 3 * 3600
    assert STALENESS_BUDGET_SECONDS["approval.remind"] == 3 * 3600


def test_cron_budget_covers_a_full_day() -> None:
    for spec in JOBS:
        if spec.kind == "cron":
            # 每日任务两次执行之间最长约 24 小时，预算必须留出余量，否则必然误报
            assert STALENESS_BUDGET_SECONDS[spec.id] > DAY


def test_cron_jobs_are_scheduled_utc_daily() -> None:
    for spec in JOBS:
        if spec.kind == "cron":
            assert spec.hour is not None and 0 <= spec.hour <= 23
            assert spec.minute is not None and 0 <= spec.minute <= 59


def test_interval_jobs_need_minutes() -> None:
    for spec in JOBS:
        if spec.kind == "interval":
            assert spec.minutes and spec.minutes > 0


class _FakeScheduler:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def add_job(self, handler: object, trigger: str, **kwargs: object) -> None:
        self.calls.append({"handler": handler, "trigger": trigger, **kwargs})


def test_register_adds_every_job_once() -> None:
    scheduler = _FakeScheduler()
    register(scheduler)  # type: ignore[arg-type]
    assert [call["id"] for call in scheduler.calls] == [spec.id for spec in JOBS]
    assert {call["trigger"] for call in scheduler.calls} == {"interval", "cron"}
    for call in scheduler.calls:
        assert call["max_instances"] == 1
        if call["trigger"] == "interval":
            assert call["minutes"]
        else:
            assert "hour" in call and "minute" in call


def test_register_rejects_broken_spec() -> None:
    from huagent.worker.schedule import JobSpec

    broken = JobSpec("broken", JOBS[0].handler, "interval")
    with pytest.raises(ValueError):
        _ = broken.budget_seconds
