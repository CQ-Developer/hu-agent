"""统计 API（design 6.7.2）：用量聚合查询与资源激活明细，按范围做权限断言。"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.db import get_session
from huagent.domain.rbac import require_org_access, require_team_access

router = APIRouter(prefix="/stats", tags=["stats"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]

UsageScope = Literal["self", "team", "org", "global"]
UsageGroupBy = Literal["day", "model", "member", "team", "org"]


class UsageTotals(ApiModel):
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    requests: int
    errors: int
    estimated_cost: float


class UsageRow(ApiModel):
    key: str
    day: date | None = None
    user_id: UUID | None = None
    team_id: UUID | None = None
    org_id: UUID | None = None
    provider: str | None = None
    model: str | None = None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    requests: int
    errors: int
    estimated_cost: float


class UsageOut(ApiModel):
    scope: str
    date_from: date
    date_to: date
    group_by: str
    currency: str = "USD"
    totals: UsageTotals
    rows: list[UsageRow]


class ActivationOut(ApiModel):
    user_id: UUID
    email: str
    resource_type: str
    ref_id: UUID | None
    name: str
    version: str | None
    enabled: bool
    device_count: int
    last_reported_at: datetime
    server_state: str | None = None


class ActivationListOut(ApiModel):
    items: list[ActivationOut]
    total: int


MAX_ROWS = 10000
GROUP_BY_DIMS: dict[str, list[str]] = {
    "day": ["day"],
    "model": ["provider", "model"],
    "member": ["user_id"],
    "team": ["team_id"],
    "org": ["org_id"],
}

_AGGREGATES = """
    COALESCE(SUM(input_tokens), 0) AS input_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens,
    COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
    COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
    COALESCE(SUM(requests), 0) AS requests,
    COALESCE(SUM(errors), 0) AS errors,
    COALESCE(SUM(estimated_cost), 0)::float8 AS estimated_cost
"""


@router.get("/usage", response_model=UsageOut)
async def usage_stats(
    actor: ActorDep,
    session: SessionDep,
    scope: Annotated[UsageScope, Query()] = "self",
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    group_by: Annotated[UsageGroupBy, Query(alias="groupBy")] = "day",
    team_id: Annotated[UUID | None, Query()] = None,
    org_id: Annotated[UUID | None, Query()] = None,
) -> UsageOut:
    end = date_to or date.today()
    start = date_from or end.replace(day=1)
    if start > end:
        raise AppError(ErrorCode.VALIDATION_FAILED, "from 不能晚于 to")

    conditions = ["day >= :start", "day <= :end"]
    params: dict[str, object] = {"start": start, "end": end}

    if scope == "self":
        conditions.append("user_id = :actor_id")
        params["actor_id"] = actor.user_id
        if group_by not in {"day", "model"}:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=self 仅支持 groupBy=day|model")
    elif scope == "team":
        if team_id is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=team 需要 teamId")
        await require_team_access(session, actor, team_id, admin=True)
        conditions.append("team_id = :team_id")
        params["team_id"] = team_id
        if group_by not in {"day", "model", "member"}:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=team 仅支持 groupBy=day|model|member")
    elif scope == "org":
        if org_id is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=org 需要 orgId")
        await require_org_access(session, actor, org_id, admin=True)
        conditions.append("org_id = :org_id")
        params["org_id"] = org_id
        if group_by not in {"day", "model", "team"}:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=org 仅支持 groupBy=day|model|team")
    else:
        if not actor.is_system_admin:
            raise AppError(ErrorCode.FORBIDDEN, "需要系统管理员权限")
        if group_by not in {"day", "model", "org"}:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=global 仅支持 groupBy=day|model|org")

    dims = GROUP_BY_DIMS[group_by]
    dim_select = ", ".join(dims)
    where = " AND ".join(conditions)
    sql = (
        f"SELECT {dim_select}, {_AGGREGATES} FROM usage_daily WHERE {where} "  # noqa: S608 —— 片段均为白名单常量
        f"GROUP BY {dim_select} ORDER BY {dim_select} LIMIT {MAX_ROWS}"
    )
    rows = (await session.execute(text(sql), params)).mappings().all()

    totals_sql = f"SELECT {_AGGREGATES} FROM usage_daily WHERE {where}"  # noqa: S608 同上
    totals = (await session.execute(text(totals_sql), params)).mappings().one()

    return UsageOut(
        scope=scope,
        date_from=start,
        date_to=end,
        group_by=group_by,
        totals=UsageTotals(**dict(totals)),
        rows=[_usage_row(row, group_by) for row in rows],
    )


@router.get("/activations", response_model=ActivationListOut)
async def activation_stats(
    actor: ActorDep,
    session: SessionDep,
    scope: Annotated[Literal["self", "team", "org", "global"], Query()] = "self",
    team_id: Annotated[UUID | None, Query()] = None,
    org_id: Annotated[UUID | None, Query()] = None,
    resource_type: Annotated[Literal["skill", "mcp"] | None, Query(alias="type")] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ActivationListOut:
    conditions: list[str] = []
    params: dict[str, object] = {"limit": limit, "offset": offset}
    joins = ""

    if scope == "self":
        conditions.append("a.user_id = :actor_id")
        params["actor_id"] = actor.user_id
    elif scope == "team":
        if team_id is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=team 需要 teamId")
        await require_team_access(session, actor, team_id, admin=True)
        joins = "JOIN team_members tm ON tm.team_id = :team_id AND tm.user_id = a.user_id AND tm.status = 'active'"
        params["team_id"] = team_id
    elif scope == "org":
        if org_id is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=org 需要 orgId")
        await require_org_access(session, actor, org_id, admin=True)
        joins = "JOIN org_members om ON om.org_id = :org_id AND om.user_id = a.user_id AND om.status = 'active'"
        params["org_id"] = org_id
    else:
        if not actor.is_system_admin:
            raise AppError(ErrorCode.FORBIDDEN, "需要系统管理员权限")

    if resource_type is not None:
        conditions.append("a.resource_type = :resource_type")
        params["resource_type"] = resource_type

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    sql = f"""
        SELECT a.user_id, u.email, a.resource_type, a.ref_id, a.name, a.version,
               bool_or(a.enabled) AS enabled,
               count(DISTINCT a.device_id) AS device_count,
               max(a.reported_at) AS last_reported_at,
               max(s.status) AS skill_status,
               max(t.status) AS team_status,
               max(o.status) AS org_status,
               max(sv.status) AS version_status
        FROM activation_reports a
        JOIN users u ON u.id = a.user_id
        {joins}
        LEFT JOIN skills s ON a.resource_type = 'skill' AND s.id = a.ref_id
        LEFT JOIN skill_versions sv ON sv.skill_id = s.id AND sv.version = a.version
        LEFT JOIN teams t ON t.id = s.team_id
        LEFT JOIN orgs o ON o.id = s.org_id
        {where}
        GROUP BY a.user_id, u.email, a.resource_type, a.ref_id, a.name, a.version
        ORDER BY max(a.reported_at) DESC
        LIMIT :limit OFFSET :offset
    """  # noqa: S608 —— 片段均为白名单常量
    rows = (await session.execute(text(sql), params)).mappings().all()
    items = [
        ActivationOut(
            user_id=row["user_id"],
            email=str(row["email"]),
            resource_type=str(row["resource_type"]),
            ref_id=row["ref_id"],
            name=str(row["name"]),
            version=row["version"],
            enabled=bool(row["enabled"]),
            device_count=int(row["device_count"]),
            last_reported_at=row["last_reported_at"],
            server_state=_derive_state(row),
        )
        for row in rows
    ]
    return ActivationListOut(items=items, total=len(items))


def _derive_state(row: RowMapping) -> str | None:
    if row["ref_id"] is None:
        return None
    if row["skill_status"] is None:
        return "not_found"
    if row["org_status"] not in (None, "active") or row["team_status"] not in (None, "active"):
        return "disabled"
    if row["skill_status"] == "disabled":
        return "disabled"
    if row["skill_status"] == "deleted":
        return "not_found"
    if row["version_status"] == "revoked":
        return "revoked"
    if row["skill_status"] == "delisted":
        return "delisted"
    return "active"


def _usage_row(row: RowMapping, group_by: str) -> UsageRow:
    key_parts = [str(row[dim]) for dim in GROUP_BY_DIMS[group_by]]
    return UsageRow(
        key=" / ".join(key_parts),
        day=row["day"] if group_by == "day" else None,
        user_id=row["user_id"] if group_by == "member" else None,
        team_id=row["team_id"] if group_by == "team" else None,
        org_id=row["org_id"] if group_by == "org" else None,
        provider=row["provider"] if group_by == "model" else None,
        model=row["model"] if group_by == "model" else None,
        input_tokens=int(row["input_tokens"]),
        output_tokens=int(row["output_tokens"]),
        cache_read_tokens=int(row["cache_read_tokens"]),
        cache_write_tokens=int(row["cache_write_tokens"]),
        requests=int(row["requests"]),
        errors=int(row["errors"]),
        estimated_cost=float(row["estimated_cost"]),
    )
