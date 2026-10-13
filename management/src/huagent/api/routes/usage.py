"""用量接收（design 6.7.1）：批量、幂等、归属校验。

- 幂等：`UNIQUE (event_id, occurred_at)`（分区表唯一约束必须含分区键）→ ON CONFLICT DO NOTHING
- 逐条校验：occurred_at 超出 ±7 天 → 计入 rejected（不阻断整批）
- 归属：team 必须存在且用户是其成员，workspace 必须属于本人；否则置空并计入 sanitized
  （不丢数据，仅去掉不可信归属，保证个人统计仍可对账）
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.db import get_session

router = APIRouter(tags=["usage"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]

MAX_EVENTS_PER_BATCH = 100
TOKEN_LIMIT = 10**9
OCCURRED_AT_WINDOW = timedelta(days=7)


class UsageEventIn(ApiModel):
    event_id: UUID
    occurred_at: datetime
    device_id: str = ""
    app_version: str = ""
    workspace_id: UUID | None = None
    team_id: UUID | None = None
    session_id_hash: str | None = None
    purpose: Literal["primary", "fast"] = "primary"
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    requests: int = 1
    duration_ms: int | None = None
    status: Literal["success", "error"] = "success"
    error_code: str | None = None


class UsageBatchIn(ApiModel):
    events: list[UsageEventIn]


class UsageBatchOut(ApiModel):
    received: int
    accepted: int
    duplicated: int
    rejected: int
    sanitized: int


SELECT_TEAM = text(
    """
    SELECT t.id, t.org_id
    FROM teams t
    JOIN team_members m ON m.team_id = t.id AND m.user_id = :user_id AND m.status = 'active'
    WHERE t.id = :team_id AND t.status = 'active'
    """
)

SELECT_WORKSPACE = text(
    "SELECT id FROM workspaces WHERE id = :workspace_id AND user_id = :user_id AND status = 'active'"
)

SELECT_EXISTING_EVENTS = text(
    """
    SELECT DISTINCT event_id FROM usage_events
    WHERE event_id = ANY(:event_ids) AND occurred_at >= :window_start AND occurred_at < :window_end
    """
)

INSERT_EVENT = text(
    """
    INSERT INTO usage_events (
      event_id, user_id, org_id, team_id, workspace_id, device_id, session_id_hash, purpose,
      provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, requests, duration_ms, status, error_code, occurred_at
    ) VALUES (
      :event_id, :user_id, :org_id, :team_id, :workspace_id, :device_id, :session_id_hash, :purpose,
      :provider, :model, :input_tokens, :output_tokens, :cache_read_tokens, :cache_write_tokens,
      :reasoning_tokens, :requests, :duration_ms, :status, :error_code, :occurred_at
    )
    ON CONFLICT (event_id, occurred_at) DO NOTHING
    RETURNING event_id
    """
)


@router.post("/usage:batch", response_model=UsageBatchOut)
async def submit_usage(
    payload: UsageBatchIn,
    actor: ActorDep,
    session: SessionDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> UsageBatchOut:
    del idempotency_key  # 幂等由 event_id 保证，头部仅作兼容
    if not payload.events:
        raise AppError(ErrorCode.VALIDATION_FAILED, "events 不能为空")
    if len(payload.events) > MAX_EVENTS_PER_BATCH:
        raise AppError(
            ErrorCode.VALIDATION_FAILED, f"单批最多 {MAX_EVENTS_PER_BATCH} 条"
        )

    now = datetime.now(UTC)
    rows: list[dict[str, object]] = []
    occurred_ats: list[datetime] = []
    rejected = 0
    sanitized = 0
    seen_event_ids: set[UUID] = set()
    duplicates_in_batch = 0

    for event in payload.events:
        occurred_at = event.occurred_at if event.occurred_at.tzinfo else event.occurred_at.replace(tzinfo=UTC)
        if abs(now - occurred_at) > OCCURRED_AT_WINDOW:
            rejected += 1
            continue
        if event.event_id in seen_event_ids:
            # 同批内重复 event_id：只收第一条（design 6.7.1 全量幂等）
            duplicates_in_batch += 1
            continue
        seen_event_ids.add(event.event_id)
        occurred_ats.append(occurred_at)

        team_id: UUID | None = None
        org_id: UUID | None = None
        if event.team_id is not None:
            team = (
                await session.execute(
                    SELECT_TEAM, {"team_id": event.team_id, "user_id": actor.user_id}
                )
            ).mappings().first()
            if team is None:
                sanitized += 1
                team_id, org_id = None, None
            else:
                team_id, org_id = team["id"], team["org_id"]

        workspace_id: UUID | None = None
        if event.workspace_id is not None:
            workspace = (
                await session.execute(
                    SELECT_WORKSPACE,
                    {"workspace_id": event.workspace_id, "user_id": actor.user_id},
                )
            ).mappings().first()
            if workspace is None:
                sanitized += 1
            else:
                workspace_id = workspace["id"]

        rows.append(
            {
                "event_id": event.event_id,
                "user_id": actor.user_id,
                "org_id": org_id,
                "team_id": team_id,
                "workspace_id": workspace_id,
                "device_id": event.device_id or actor.device_id,
                "session_id_hash": event.session_id_hash,
                "purpose": event.purpose,
                "provider": event.provider[:80],
                "model": event.model[:120],
                "input_tokens": min(event.input_tokens, TOKEN_LIMIT),
                "output_tokens": min(event.output_tokens, TOKEN_LIMIT),
                "cache_read_tokens": min(event.cache_read_tokens, TOKEN_LIMIT),
                "cache_write_tokens": min(event.cache_write_tokens, TOKEN_LIMIT),
                "reasoning_tokens": min(event.reasoning_tokens, TOKEN_LIMIT),
                "requests": event.requests,
                "duration_ms": event.duration_ms,
                "status": event.status,
                "error_code": event.error_code,
                "occurred_at": occurred_at,
            }
        )

    accepted = 0
    duplicates = duplicates_in_batch
    if rows:
        # event_id 幂等：先查已存在（occurred_at 用事件自身窗口做分区裁剪，容忍重试时时间戳毫秒差异）
        window_start = min(occurred_ats) - timedelta(minutes=1)
        window_end = max(occurred_ats) + timedelta(minutes=1)
        existing = (
            await session.execute(
                SELECT_EXISTING_EVENTS,
                {
                    "event_ids": [row["event_id"] for row in rows],
                    "window_start": window_start,
                    "window_end": window_end,
                },
            )
        ).scalars().all()
        existing_ids = set(existing)
        if existing_ids:
            rows = [row for row in rows if row["event_id"] not in existing_ids]
            duplicates += len(existing_ids)

    if rows:
        try:
            result = await session.execute(INSERT_EVENT, rows)
            accepted = len(result.mappings().all())
        except SQLAlchemyError:
            # 批量失败（如某月分区缺失）时逐条写入，单条失败只计 rejected
            await session.rollback()
            for row in rows:
                try:
                    inserted = (await session.execute(INSERT_EVENT, row)).mappings().all()
                    accepted += len(inserted)
                except SQLAlchemyError:
                    await session.rollback()
                    rejected += 1
    await session.commit()

    duplicated = duplicates + (len(rows) - accepted)
    return UsageBatchOut(
        received=len(payload.events),
        accepted=accepted,
        duplicated=duplicated,
        rejected=rejected,
        sanitized=sanitized,
    )
