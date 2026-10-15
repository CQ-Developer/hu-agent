"""市场资源生命周期（Skill / MCP 共用骨架，design 6.4 / 6.5）。

两者数据模型不同（包 + semver vs 连接描述 + 整数版本），因此只抽**语义完全一致**的部分：

- 按 id 加载资源：未找到 / 已停用的统一报错语义；
- 状态迁移：鉴权 → 更新（含 status_revision bump）→ 审计 → 提交；
- 软删除：鉴权 → 标记 deleted → 定向通知 → 审计 → 提交。

提交新版本、撤回版本、市场列表因字段与 SQL 差异较大，保留在各路由内显式实现——
这是刻意的：共享它们需要动态表名或十几个回调参数，收益低于可读性成本。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from uuid import UUID

from fastapi import Request
from sqlalchemy import TextClause
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.rbac import require_team_access


@dataclass(frozen=True)
class ResourceSpec:
    """一类市场资源的 SQL 与标签；SQL 由调用方显式提供（无动态表名/字符串拼接）。"""

    resource_type: str  # 'skill' | 'mcp'
    target_type: str  # 审计 target_type：'skill' | 'mcp_server'
    load_sql: TextClause
    #: load_sql 的资源 id 绑定名（Skill 用 skill_id，MCP 用 server_id）
    load_param: str
    update_status_sql: TextClause
    mark_deleted_sql: TextClause
    not_found_message: str
    disabled_message: str


async def load_resource(
    session: AsyncSession,
    spec: ResourceSpec,
    params: dict[str, object],
    *,
    include_disabled: bool = False,
) -> RowMapping:
    row = (await session.execute(spec.load_sql, params)).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, spec.not_found_message)
    if row["status"] == "disabled" and not include_disabled:
        raise AppError(ErrorCode.CONFLICT, spec.disabled_message)
    return row


async def set_resource_status(
    session: AsyncSession,
    actor: Actor,
    request: Request,
    spec: ResourceSpec,
    resource_id: UUID,
    status: str,
    *,
    admin_required: bool,
    reason: str | None = None,
) -> dict[str, object]:
    row = await load_resource(session, spec, {spec.load_param: resource_id}, include_disabled=True)
    await require_team_access(session, actor, row["team_id"], admin=admin_required)
    await session.execute(spec.update_status_sql, {"id": resource_id, "status": status, "reason": reason})
    await record_audit(
        session,
        action=f"{spec.resource_type}.{'disable' if status == 'disabled' else status}",
        actor_id=actor.user_id,
        org_id=row["org_id"],
        target_type=spec.target_type,
        target_id=str(resource_id),
        detail={"status": status, "reason": reason},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"id": str(resource_id), "status": status, "reason": reason}


async def delete_resource(
    session: AsyncSession,
    actor: Actor,
    request: Request,
    spec: ResourceSpec,
    resource_id: UUID,
    notify: Callable[[RowMapping], Awaitable[int]],
) -> dict[str, object]:
    row = await load_resource(session, spec, {spec.load_param: resource_id})
    await require_team_access(session, actor, row["team_id"], admin=True)
    await session.execute(spec.mark_deleted_sql, {"id": resource_id})
    await notify(row)
    await record_audit(
        session,
        action=f"{spec.resource_type}.delete",
        actor_id=actor.user_id,
        org_id=row["org_id"],
        target_type=spec.target_type,
        target_id=str(resource_id),
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"id": str(resource_id), "status": "deleted"}
