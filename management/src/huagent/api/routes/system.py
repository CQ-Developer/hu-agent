"""系统路由：健康检查、schema 信息与 Prometheus 指标（阶段 0 冒烟 / 运维监控用）。"""

from __future__ import annotations

import hmac
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.common.metrics import BUILD_INFO, DB_GAUGE, JOB_BUDGET, JOB_STATUS, JOB_TIMESTAMP, REGISTRY
from huagent.domain.db import get_session
from huagent.domain.schema import applied_versions
from huagent.worker.schedule import STALENESS_BUDGET_SECONDS

router = APIRouter()

Session = Annotated[AsyncSession, Depends(get_session)]

API_VERSION = "0.1.0"

COLLECT_ERRORS = REGISTRY.counter("huagent_metrics_collect_errors_total", "采集数据库指标失败次数")

# 采集时从数据库读取的即时状态量（SQL 均为常量，无外部输入）
_DB_GAUGES: dict[str, str] = {
    "users_total": "SELECT count(*) FROM users",
    "approvals_pending": "SELECT count(*) FROM approval_requests WHERE status = 'pending'",
    "snapshots_uploading": "SELECT count(*) FROM workspace_snapshots WHERE status = 'uploading'",
    "skills_published": "SELECT count(*) FROM skill_versions WHERE status = 'published'",
    "activations_total": "SELECT count(*) FROM activation_reports",
}
_JOB_ROWS = "SELECT job_id, status, started_at, finished_at FROM job_runs"


class HealthResponse(BaseModel):
    status: str
    time: str


class SchemaResponse(BaseModel):
    applied: list[str]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", time=datetime.now(UTC).isoformat())


@router.get("/schema", response_model=SchemaResponse)
async def schema(session: Session) -> SchemaResponse:
    return SchemaResponse(applied=await applied_versions(session))


@router.get("/metrics", include_in_schema=False)
async def metrics(request: Request, session: Session) -> Response:
    """Prometheus 文本格式指标（见 docs/delivery/monitoring.md）。"""
    settings = get_settings()
    if not settings.metrics_enabled:
        raise AppError(ErrorCode.NOT_FOUND, "指标端点未启用")
    if settings.metrics_token:
        header = request.headers.get("authorization", "")
        provided = header[7:] if header.lower().startswith("bearer ") else ""
        if not hmac.compare_digest(provided, settings.metrics_token):
            raise AppError(ErrorCode.UNAUTHENTICATED, "指标令牌无效")

    await _collect_dynamic_metrics(session)
    return Response(REGISTRY.render(), media_type="text/plain; version=0.0.4; charset=utf-8")


async def _collect_dynamic_metrics(session: AsyncSession) -> None:
    """采集数据库侧指标；失败时降级（已由 /ready 覆盖数据库可用性判定）并计入错误计数。"""
    try:
        await _refresh_dynamic_metrics(session)
    except SQLAlchemyError:
        COLLECT_ERRORS.inc()


async def _refresh_dynamic_metrics(session: AsyncSession) -> None:
    """刷新「采集时取值」的指标（清空后重写，避免陈旧样本）。"""
    versions = await applied_versions(session)
    BUILD_INFO.clear()
    BUILD_INFO.set(1, version=API_VERSION, schema_version=",".join(versions) or "unknown")

    DB_GAUGE.clear()
    for metric, sql in _DB_GAUGES.items():
        value = (await session.execute(text(sql))).scalar_one()
        DB_GAUGE.set(float(value), metric=metric)

    JOB_STATUS.clear()
    JOB_TIMESTAMP.clear()
    JOB_BUDGET.clear()
    for job_id, budget_seconds in STALENESS_BUDGET_SECONDS.items():
        # 预算随任务表变化，与运行历史无关，因此无论该任务是否跑过都要导出
        JOB_BUDGET.set(float(budget_seconds), job_id=job_id)
    rows = (await session.execute(text(_JOB_ROWS))).mappings().all()
    for row in rows:
        JOB_STATUS.set(1, job_id=row["job_id"], status=row["status"])
        JOB_TIMESTAMP.set(row["started_at"].timestamp(), job_id=row["job_id"], phase="started")
        if row["finished_at"] is not None:
            JOB_TIMESTAMP.set(row["finished_at"].timestamp(), job_id=row["job_id"], phase="finished")
