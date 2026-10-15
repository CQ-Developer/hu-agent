"""资源状态查询与激活上报（design 5.12 / 6.4.5 / 6.7）。

- `POST /resources/status:check`：客户端批量查询已安装市场资源状态
- `POST /me/activations:report`：上报本设备激活快照（先删同设备同作用域旧行再插）
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.db import get_session
from huagent.domain.rbac import team_ids_for_user

router = APIRouter(tags=["resources"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]

MAX_STATUS_ITEMS = 100
StatusLiteral = Literal["active", "delisted", "disabled", "revoked", "not_found", "unknown"]


class StatusItemIn(ApiModel):
    type: Literal["skill", "mcp"]
    ref_id: UUID
    version: str | None = None


class StatusCheckIn(ApiModel):
    items: list[StatusItemIn]


class StatusItemOut(ApiModel):
    type: str
    ref_id: UUID
    version: str | None = None
    status: StatusLiteral
    reason: str | None = None
    replacement_version: str | None = None
    revision: int | None = None


class StatusCheckOut(ApiModel):
    checked_at: datetime
    items: list[StatusItemOut]


class ActivationItemIn(ApiModel):
    type: Literal["skill", "mcp"]
    source: Literal["market", "local"]
    ref_id: UUID | None = None
    name: str
    version: str | None = None
    enabled: bool = False


class ActivationReportIn(ApiModel):
    device_id: str
    scope: Literal["global", "workspace"]
    workspace_id: UUID | None = None
    items: list[ActivationItemIn]
    reported_at: datetime | None = None


SELECT_SKILL_STATUS = text(
    """
    SELECT s.id, s.name, s.team_id, s.status, s.status_revision, s.disabled_reason,
           s.latest_published_version_id::text AS latest_version_id,
           t.status AS team_status, o.status AS org_status
    FROM skills s JOIN teams t ON t.id = s.team_id JOIN orgs o ON o.id = s.org_id
    WHERE s.id = :ref_id
    """
)

SELECT_SKILL_VERSION_STATUS = text(
    """
    SELECT v.id, v.version, v.status, v.revoked_reason
    FROM skill_versions v WHERE v.skill_id = :skill_id AND v.version = :version
    """
)

SELECT_LATEST_SKILL_VERSION = text(
    """
    SELECT version FROM skill_versions
    WHERE skill_id = :skill_id AND status IN ('published', 'superseded') AND version <> :excluded
    ORDER BY created_at DESC LIMIT 1
    """
)

SELECT_MCP_STATUS = text(
    """
    SELECT m.id, m.name, m.team_id, m.status, m.status_revision, m.disabled_reason,
           t.status AS team_status, o.status AS org_status
    FROM mcp_servers m JOIN teams t ON t.id = m.team_id JOIN orgs o ON o.id = m.org_id
    WHERE m.id = :ref_id
    """
)

SELECT_MCP_VERSION_STATUS = text(
    """
    SELECT v.id, v.version::text AS version, v.status, v.revoked_reason
    FROM mcp_server_versions v WHERE v.mcp_server_id = :server_id AND v.version = :version
    """
)

SELECT_LATEST_MCP_VERSION = text(
    """
    SELECT version::text AS version FROM mcp_server_versions
    WHERE mcp_server_id = :server_id AND status IN ('published', 'superseded') AND version <> :excluded
    ORDER BY version DESC LIMIT 1
    """
)

DELETE_ACTIVATIONS = text(
    """
    DELETE FROM activation_reports
    WHERE user_id = :user_id AND device_id = :device_id AND scope = :scope
      AND workspace_id IS NOT DISTINCT FROM :workspace_id
    """
)

INSERT_ACTIVATION = text(
    """
    INSERT INTO activation_reports (user_id, device_id, scope, workspace_id, resource_type, resource_source,
                                    ref_id, resource_key, name, version, enabled, reported_at)
    VALUES (:user_id, :device_id, :scope, :workspace_id, :resource_type, :resource_source,
            :ref_id, :resource_key, :name, :version, :enabled, :reported_at)
    """
)


@router.post("/resources/status:check", response_model=StatusCheckOut)
async def check_status(payload: StatusCheckIn, actor: ActorDep, session: SessionDep) -> StatusCheckOut:
    if not payload.items:
        raise AppError(ErrorCode.VALIDATION_FAILED, "items 不能为空")
    if len(payload.items) > MAX_STATUS_ITEMS:
        raise AppError(ErrorCode.VALIDATION_FAILED, f"单次最多查询 {MAX_STATUS_ITEMS} 条")

    visible_teams = set(await team_ids_for_user(session, actor.user_id))
    results: list[StatusItemOut] = []
    for item in payload.items:
        if item.type == "skill":
            results.append(await _check_skill(session, visible_teams, item))
        else:
            results.append(await _check_mcp(session, visible_teams, item))
    return StatusCheckOut(checked_at=datetime.now(UTC), items=results)


@router.post("/me/activations:report")
async def report_activations(
    payload: ActivationReportIn,
    actor: ActorDep,
    session: SessionDep,
) -> dict[str, object]:
    if payload.scope == "workspace" and payload.workspace_id is None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "scope=workspace 时必须提供 workspaceId")
    if payload.scope == "global" and payload.workspace_id is not None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "scope=global 时不能提供 workspaceId")
    if payload.workspace_id is not None:
        owned = (
            await session.execute(
                text("SELECT 1 FROM workspaces WHERE id = :id AND user_id = :user_id"),
                {"id": payload.workspace_id, "user_id": actor.user_id},
            )
        ).first()
        if owned is None:
            raise AppError(ErrorCode.NOT_FOUND, "工作空间不存在或不属于当前用户")

    reported_at = payload.reported_at or datetime.now(UTC)
    await session.execute(
        DELETE_ACTIVATIONS,
        {
            "user_id": actor.user_id,
            "device_id": payload.device_id,
            "scope": payload.scope,
            "workspace_id": payload.workspace_id,
        },
    )
    for item in payload.items:
        resource_key = str(item.ref_id) if item.source == "market" and item.ref_id else item.name
        await session.execute(
            INSERT_ACTIVATION,
            {
                "user_id": actor.user_id,
                "device_id": payload.device_id,
                "scope": payload.scope,
                "workspace_id": payload.workspace_id,
                "resource_type": item.type,
                "resource_source": item.source,
                "ref_id": item.ref_id,
                "resource_key": resource_key,
                "name": item.name,
                "version": item.version,
                "enabled": item.enabled,
                "reported_at": reported_at,
            },
        )
    await session.commit()
    return {"reported": len(payload.items), "scope": payload.scope}


async def _check_skill(
    session: AsyncSession, visible_teams: set[UUID], item: StatusItemIn
) -> StatusItemOut:
    row = (await session.execute(SELECT_SKILL_STATUS, {"ref_id": item.ref_id})).mappings().first()
    if row is None or row["team_id"] not in visible_teams or row["status"] == "deleted":
        return StatusItemOut(type="skill", ref_id=item.ref_id, version=item.version, status="not_found")

    base_reason: str | None = None
    if row["org_status"] != "active":
        base_reason = "所属组织已被冻结"
    elif row["team_status"] != "active":
        base_reason = "所属团队已归档"
    elif row["status"] == "disabled":
        base_reason = str(row["disabled_reason"] or "管理员已停用")

    if base_reason is not None:
        return StatusItemOut(
            type="skill",
            ref_id=item.ref_id,
            version=item.version,
            status="disabled",
            reason=base_reason,
            revision=int(row["status_revision"]),
        )

    if item.version:
        version_row = (
            await session.execute(
                SELECT_SKILL_VERSION_STATUS, {"skill_id": item.ref_id, "version": item.version}
            )
        ).mappings().first()
        if version_row is not None and version_row["status"] == "revoked":
            replacement = (
                await session.execute(
                    SELECT_LATEST_SKILL_VERSION,
                    {"skill_id": item.ref_id, "excluded": item.version},
                )
            ).scalar_one_or_none()
            return StatusItemOut(
                type="skill",
                ref_id=item.ref_id,
                version=item.version,
                status="revoked",
                reason=str(version_row["revoked_reason"] or "该版本已被撤回"),
                replacement_version=str(replacement) if replacement and replacement != item.version else None,
                revision=int(row["status_revision"]),
            )

    if row["status"] == "delisted":
        return StatusItemOut(
            type="skill",
            ref_id=item.ref_id,
            version=item.version,
            status="delisted",
            reason="资源已下架，不再接收更新",
            revision=int(row["status_revision"]),
        )
    return StatusItemOut(
        type="skill",
        ref_id=item.ref_id,
        version=item.version,
        status="active",
        revision=int(row["status_revision"]),
    )


async def _check_mcp(
    session: AsyncSession, visible_teams: set[UUID], item: StatusItemIn
) -> StatusItemOut:
    row = (await session.execute(SELECT_MCP_STATUS, {"ref_id": item.ref_id})).mappings().first()
    if row is None or row["team_id"] not in visible_teams or row["status"] == "deleted":
        return StatusItemOut(type="mcp", ref_id=item.ref_id, version=item.version, status="not_found")

    base_reason: str | None = None
    if row["org_status"] != "active":
        base_reason = "所属组织已被冻结"
    elif row["team_status"] != "active":
        base_reason = "所属团队已归档"
    elif row["status"] == "disabled":
        base_reason = str(row["disabled_reason"] or "管理员已停用")

    if base_reason is not None:
        return StatusItemOut(
            type="mcp",
            ref_id=item.ref_id,
            version=item.version,
            status="disabled",
            reason=base_reason,
            revision=int(row["status_revision"]),
        )

    if item.version:
        try:
            version_number = int(item.version)
        except ValueError:
            version_number = None
        if version_number is not None:
            version_row = (
                await session.execute(
                    SELECT_MCP_VERSION_STATUS, {"server_id": item.ref_id, "version": version_number}
                )
            ).mappings().first()
            if version_row is not None and version_row["status"] == "revoked":
                replacement = (
                    await session.execute(
                        SELECT_LATEST_MCP_VERSION,
                        {"server_id": item.ref_id, "excluded": item.version},
                    )
                ).scalar_one_or_none()
                return StatusItemOut(
                    type="mcp",
                    ref_id=item.ref_id,
                    version=item.version,
                    status="revoked",
                    reason=str(version_row["revoked_reason"] or "该版本已被撤回"),
                    replacement_version=str(replacement) if replacement and replacement != item.version else None,
                    revision=int(row["status_revision"]),
                )

    if row["status"] == "delisted":
        return StatusItemOut(
            type="mcp",
            ref_id=item.ref_id,
            version=item.version,
            status="delisted",
            reason="资源已下架，不再接收更新",
            revision=int(row["status_revision"]),
        )
    return StatusItemOut(
        type="mcp",
        ref_id=item.ref_id,
        version=item.version,
        status="active",
        revision=int(row["status_revision"]),
    )
