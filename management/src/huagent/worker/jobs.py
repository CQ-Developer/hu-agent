"""定时任务（design 6.11）：用量聚合、分区维护、快照清理、邀请过期、审批超时。

每个任务幂等，可重跑；多实例防重：PostgreSQL advisory lock + job_runs 记录。
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.common.config import get_settings
from huagent.domain.db import get_session_factory
from huagent.domain.notifications import notify_org_admins, notify_team_admins
from huagent.domain.settings import get_int_setting
from huagent.storage.objects import get_object_store

logger = logging.getLogger(__name__)

_ACQUIRE_LOCK = text("SELECT pg_try_advisory_lock(hashtext(:name)) AS locked")
_RELEASE_LOCK = text("SELECT pg_advisory_unlock(hashtext(:name))")
_JOB_START = text(
    """
    INSERT INTO job_runs (job_id, status, started_at, finished_at, error)
    VALUES (:job_id, 'running', now(), NULL, NULL)
    ON CONFLICT (job_id) DO UPDATE SET status = 'running', started_at = now(), finished_at = NULL, error = NULL
    """
)
_JOB_FINISH = text(
    "UPDATE job_runs SET status = :status, finished_at = now(), error = :error WHERE job_id = :job_id"
)


async def run_job(name: str, job: Callable[[AsyncSession], Awaitable[int]]) -> int | None:
    """加锁执行任务；已被其他实例持有或失败时返回 None 并记录。"""
    factory = get_session_factory()
    async with factory() as session:
        acquired = (await session.execute(_ACQUIRE_LOCK, {"name": name})).scalar_one()
        if not acquired:
            logger.info("任务 %s 已在其他实例执行，跳过", name)
            return None
        try:
            await session.execute(_JOB_START, {"job_id": name})
            await session.commit()
            count = await job(session)
            await session.execute(_JOB_FINISH, {"job_id": name, "status": "succeeded", "error": None})
            await session.commit()
            logger.info("任务 %s 完成，处理 %s 项", name, count)
            return count
        except Exception as exc:  # noqa: BLE001 —— 任务失败必须记录并释放锁
            await session.rollback()
            await session.execute(_JOB_FINISH, {"job_id": name, "status": "failed", "error": str(exc)[:500]})
            await session.commit()
            logger.exception("任务 %s 失败：%s", name, exc)
            return None
        finally:
            await session.execute(_RELEASE_LOCK, {"name": name})
            await session.commit()


# ---------------------------------------------------------------------------
# 用量聚合（design 6.7.1）
# ---------------------------------------------------------------------------

_SELECT_BUCKETS = text(
    """
    SELECT DISTINCT date_trunc('hour', occurred_at) AS bucket
    FROM usage_events
    WHERE aggregated_at IS NULL AND occurred_at < date_trunc('hour', now())
    ORDER BY 1
    LIMIT 48
    """
)

_AGGREGATE_BUCKET = text(
    """
    SELECT (occurred_at AT TIME ZONE 'UTC')::date AS day,
           user_id, org_id, team_id, provider, model,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
           COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
           COALESCE(SUM(requests), 0) AS requests,
           COUNT(*) FILTER (WHERE status = 'error') AS errors
    FROM usage_events
    WHERE occurred_at >= :bucket AND occurred_at < :bucket + interval '1 hour' AND aggregated_at IS NULL
    GROUP BY 1, 2, 3, 4, 5, 6
    """
)

_MARK_AGGREGATED = text(
    """
    UPDATE usage_events SET aggregated_at = now()
    WHERE occurred_at >= :bucket AND occurred_at < :bucket + interval '1 hour' AND aggregated_at IS NULL
    """
)

_UPSERT_DAILY = text(
    """
    INSERT INTO usage_daily (day, user_id, org_id, team_id, provider, model, input_tokens, output_tokens,
                             cache_read_tokens, cache_write_tokens, requests, errors, estimated_cost)
    VALUES (:day, :user_id, :org_id, :team_id, :provider, :model, :input_tokens, :output_tokens,
            :cache_read_tokens, :cache_write_tokens, :requests, :errors, :estimated_cost)
    ON CONFLICT (day, user_id, org_id, team_id, provider, model) DO UPDATE SET
      input_tokens = usage_daily.input_tokens + EXCLUDED.input_tokens,
      output_tokens = usage_daily.output_tokens + EXCLUDED.output_tokens,
      cache_read_tokens = usage_daily.cache_read_tokens + EXCLUDED.cache_read_tokens,
      cache_write_tokens = usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens,
      requests = usage_daily.requests + EXCLUDED.requests,
      errors = usage_daily.errors + EXCLUDED.errors,
      estimated_cost = usage_daily.estimated_cost + EXCLUDED.estimated_cost
    """
)

_SELECT_PRICES = text(
    """
    SELECT DISTINCT ON (provider, model)
           provider, model, input_per_1k, output_per_1k, cache_read_per_1k, cache_write_per_1k
    FROM model_prices
    WHERE effective_from <= :day
    ORDER BY provider, model, effective_from DESC
    """
)


async def aggregate_usage(session: AsyncSession) -> int:
    """把已完整过去的小时桶聚合进 usage_daily；每个桶一个事务（可重跑不重复计数）。"""
    buckets = [row[0] for row in (await session.execute(_SELECT_BUCKETS)).all()]
    total = 0
    for bucket in buckets:
        rows = (await session.execute(_AGGREGATE_BUCKET, {"bucket": bucket})).mappings().all()
        if rows:
            day = rows[0]["day"]
            prices = {
                (row["provider"], row["model"]): row
                for row in (await session.execute(_SELECT_PRICES, {"day": day})).mappings().all()
            }
            for row in rows:
                await session.execute(
                    _UPSERT_DAILY,
                    {
                        **dict(row),
                        "estimated_cost": _estimate_cost(row, prices.get((row["provider"], row["model"]))),
                    },
                )
            await session.execute(_MARK_AGGREGATED, {"bucket": bucket})
            total += len(rows)
        # 聚合与标记在同一事务：崩溃回滚后可安全重跑
        await session.commit()
    return total


def _estimate_cost(row: Any, price: Any) -> float:
    if price is None:
        return 0.0
    return round(
        int(row["input_tokens"]) / 1000 * float(price["input_per_1k"])
        + int(row["output_tokens"]) / 1000 * float(price["output_per_1k"])
        + int(row["cache_read_tokens"]) / 1000 * float(price["cache_read_per_1k"])
        + int(row["cache_write_tokens"]) / 1000 * float(price["cache_write_per_1k"]),
        6,
    )


# ---------------------------------------------------------------------------
# 分区维护（design 6.7.1 / 6.11）
# ---------------------------------------------------------------------------

_CREATE_PARTITIONS = text(
    """
    DO $$
    DECLARE
      base date := date_trunc('month', now())::date;
      i    integer;
      part text;
    BEGIN
      FOR i IN 0..2 LOOP
        part := 'usage_events_' || to_char(base + (i || ' month')::interval, 'YYYYMM');
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
          part,
          base + (i || ' month')::interval,
          base + ((i + 1) || ' month')::interval
        );
      END LOOP;
    END $$;
    """
)

_SELECT_PARTITIONS = text(
    """
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'usage_events'
    """
)


async def maintain_usage_partitions(session: AsyncSession) -> int:
    """建未来 2 个月分区；删除超过保留期的旧分区（design 6.11 每日任务）。"""
    await session.execute(_CREATE_PARTITIONS)
    retention_days = await get_int_setting(session, "usage.retention_days", 90)
    cutoff = datetime.now(UTC).date()
    cutoff = cutoff.replace(day=1)
    # 保留期内不删；按月判断：分区月份结束时间 < cutoff - retention
    dropped = 0
    parts = [row[0] for row in (await session.execute(_SELECT_PARTITIONS)).all()]
    for name in parts:
        suffix = name.rsplit("_", 1)[-1]
        if len(suffix) != 6 or not suffix.isdigit():
            continue
        year, month = int(suffix[:4]), int(suffix[4:])
        partition_end = datetime(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1, tzinfo=UTC)
        age_days = (datetime.now(UTC) - partition_end).days
        if age_days > retention_days:
            await session.execute(text(f'ALTER TABLE usage_events DETACH PARTITION "{name}"'))
            await session.execute(text(f'DROP TABLE IF EXISTS "{name}"'))
            dropped += 1
    return dropped


# ---------------------------------------------------------------------------
# 快照清理（design 6.6.2 / 6.6.3）
# ---------------------------------------------------------------------------

_SELECT_TIMEOUT_UPLOADS = text(
    """
    SELECT id, object_key FROM workspace_snapshots
    WHERE status = 'uploading' AND created_at < now() - make_interval(hours => :hours)
    """
)

_SELECT_WORKSPACES = text("SELECT id FROM workspaces WHERE status <> 'archived'")

_SELECT_EXPIRED_SNAPSHOTS = text(
    """
    SELECT id, object_key FROM workspace_snapshots
    WHERE workspace_id = :workspace_id AND status = 'active' AND pinned = false
      AND id <> COALESCE(
        (SELECT latest_snapshot_id FROM workspaces WHERE id = :workspace_id),
        '00000000-0000-0000-0000-000000000000'::uuid
      )
    ORDER BY version DESC
    OFFSET :keep
    """
)

_RECOMPUTE_STORAGE = text(
    """
    UPDATE workspaces SET storage_bytes = COALESCE((
      SELECT SUM(size_bytes) FROM workspace_snapshots
      WHERE workspace_id = :workspace_id AND status = 'active'
    ), 0) WHERE id = :workspace_id
    """
)


async def cleanup_snapshots(session: AsyncSession) -> int:
    """上传超时与超保留版本的清理：先删对象再删记录（design 6.6.2 / 6.6.3）。"""
    settings = get_settings()
    store = get_object_store("snapshots")
    removed = 0

    for timeout_row in (
        await session.execute(_SELECT_TIMEOUT_UPLOADS, {"hours": settings.snapshot_uploading_timeout_hours})
    ).mappings().all():
        store.delete(str(timeout_row["object_key"]))
        await session.execute(
            text("UPDATE workspace_snapshots SET status = 'aborted' WHERE id = :id"),
            {"id": timeout_row["id"]},
        )
        removed += 1

    retention = await get_int_setting(session, "snapshot.retention", settings.snapshot_default_retention)
    for workspace_row in (await session.execute(_SELECT_WORKSPACES)).all():
        workspace_id = workspace_row[0]
        expired = (
            await session.execute(_SELECT_EXPIRED_SNAPSHOTS, {"workspace_id": workspace_id, "keep": retention})
        ).mappings().all()
        for snapshot in expired:
            store.delete(str(snapshot["object_key"]))
            await session.execute(
                text("DELETE FROM workspace_snapshots WHERE id = :id"), {"id": snapshot["id"]}
            )
            removed += 1
        if expired:
            await session.execute(_RECOMPUTE_STORAGE, {"workspace_id": workspace_id})
    await session.commit()
    return removed


# ---------------------------------------------------------------------------
# 邀请过期与审批超时（design 6.3.1 / 6.3.4）
# ---------------------------------------------------------------------------


async def mark_expired_invitations(session: AsyncSession) -> int:
    result = await session.execute(
        text("UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < now()")
    )
    await session.commit()
    return int(getattr(result, "rowcount", 0) or 0)


_SELECT_APPROVALS_48H = text(
    """
    SELECT a.id, a.type, a.requester_id, a.org_id, a.team_id, a.target_id, u.display_name
    FROM approval_requests a JOIN users u ON u.id = a.requester_id
    WHERE a.status = 'pending' AND a.created_at < now() - interval '48 hours'
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.type = 'approval.reminder' AND n.payload->>'approvalId' = a.id::text
      )
    """
)

_MARK_STALE = text(
    """
    UPDATE approval_requests SET status = 'stale'
    WHERE status = 'pending' AND created_at < now() - interval '7 days'
    """
)


async def remind_and_expire_approvals(session: AsyncSession) -> int:
    """48h 未处理提醒一次；7 天标记 stale（design 6.3.1）。"""
    reminded = 0
    for row in (await session.execute(_SELECT_APPROVALS_48H)).mappings().all():
        payload = {"approvalId": str(row["id"]), "type": row["type"]}
        params = {
            "actor": row["display_name"],
            "approval_type": row["type"],
        }
        if row["type"] == "org_create":
            admins = (
                await session.execute(text("SELECT id FROM users WHERE is_system_admin AND status = 'active'"))
            ).scalars().all()
            from huagent.domain.notifications import notify

            await notify(session, admins, kind="approval.reminder", params=params, payload=payload)
        elif row["org_id"] is not None:
            await notify_org_admins(
                session, row["org_id"], kind="approval.reminder", params=params, payload=payload
            )
        elif row["team_id"] is not None:
            await notify_team_admins(
                session, row["team_id"], kind="approval.reminder", params=params, payload=payload
            )
        reminded += 1
    result = await session.execute(_MARK_STALE)
    stale = int(getattr(result, "rowcount", 0) or 0)
    await session.commit()
    return reminded + stale


# ---------------------------------------------------------------------------
# 调度入口
# ---------------------------------------------------------------------------


async def heartbeat() -> None:
    """占位任务：验证调度器可用。"""
    logger.info("worker heartbeat")


async def job_aggregate_usage() -> None:
    await run_job("usage.aggregate", aggregate_usage)


async def job_maintain_partitions() -> None:
    await run_job("usage.partitions", maintain_usage_partitions)


async def job_cleanup_snapshots() -> None:
    await run_job("snapshot.cleanup", cleanup_snapshots)


async def job_expire_invitations() -> None:
    await run_job("invitation.expire", mark_expired_invitations)


async def job_remind_approvals() -> None:
    await run_job("approval.remind", remind_and_expire_approvals)
