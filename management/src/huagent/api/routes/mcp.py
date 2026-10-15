"""MCP 市场服务端（design 6.5 / 6.9.2）。

与 Skill 市场的差异：MCP 资源是**连接描述**（配置模板 + env_schema），没有代码包与对象存储；
版本号是递增整数，发布同样走团队管理员审批（approvals.py 的 `mcp_version_publish`）。
`env_schema.secret = true` 的项服务端只声明，**永远不接收、不存储值**（值由客户端写入密钥库）。
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.notifications import notify_activation_users, notify_team_admins
from huagent.domain.rbac import require_team_access, team_ids_for_user
from huagent.domain.resource_admin import ResourceSpec, delete_resource, load_resource, set_resource_status

router = APIRouter(tags=["mcp"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]

MAX_ENV_FIELDS = 50
MAX_DOCS_MD = 50_000
ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

McpTransport = Literal["stdio", "sse", "http"]


class McpEnvField(ApiModel):
    key: str
    label: str
    secret: bool = False
    required: bool = False
    help: str | None = None


class McpServerOut(ApiModel):
    id: UUID
    org_id: UUID
    team_id: UUID
    name: str
    description: str
    tags: list[str]
    status: str
    status_revision: int
    latest_version: int | None
    updated_at: datetime


class McpVersionOut(ApiModel):
    id: UUID
    version: int
    status: str
    transport: str
    changelog: str | None
    created_at: datetime


class McpServerDetailOut(McpServerOut):
    disabled_reason: str | None = None
    config_template: dict[str, object]
    env_schema: list[McpEnvField]
    docs_md: str
    versions: list[McpVersionOut]


class McpServerListOut(ApiModel):
    items: list[McpServerOut]
    total: int


class McpVersionIn(ApiModel):
    transport: McpTransport
    config_template: dict[str, object]
    env_schema: list[McpEnvField] = Field(default_factory=list)
    docs_md: str = ""
    changelog: str = ""


class McpServerCreateIn(McpVersionIn):
    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)


SELECT_TEAM_SERVERS = text(
    """
    SELECT s.id, s.org_id, s.team_id, s.name, s.description, s.tags, s.status, s.status_revision,
           v.version AS latest_version, s.updated_at
    FROM mcp_servers s
    LEFT JOIN mcp_server_versions v ON v.id = s.latest_published_version_id
    WHERE s.team_id = :team_id AND s.status <> 'deleted'
      AND (:status = '' OR s.status = :status)
      AND (:q = '' OR s.name ILIKE '%' || :q || '%' OR s.description ILIKE '%' || :q || '%')
    ORDER BY s.updated_at DESC LIMIT :limit OFFSET :offset
    """
)

SELECT_SERVER = text(
    """
    SELECT id, org_id, team_id, name, description, tags, status, status_revision, disabled_reason,
           latest_published_version_id, updated_at, created_by
    FROM mcp_servers WHERE id = :server_id AND status <> 'deleted'
    """
)

SELECT_VERSIONS = text(
    """
    SELECT id, version, status, transport, changelog, created_at
    FROM mcp_server_versions WHERE mcp_server_id = :server_id ORDER BY version DESC
    """
)

SELECT_VERSION = text(
    """
    SELECT id, mcp_server_id, version, status, transport, config_template, env_schema, docs_md
    FROM mcp_server_versions WHERE mcp_server_id = :server_id AND version = :version
    """
)

MARKETPLACE = text(
    """
    SELECT s.id, s.org_id, s.team_id, s.name, s.description, s.tags, s.status, s.status_revision,
           v.version AS latest_version, s.updated_at
    FROM mcp_servers s
    LEFT JOIN mcp_server_versions v ON v.id = s.latest_published_version_id
    WHERE s.team_id = ANY(:team_ids) AND s.status = 'published'
      AND (:q = '' OR s.name ILIKE '%' || :q || '%' OR s.description ILIKE '%' || :q || '%')
      AND (:tag = '' OR :tag = ANY(s.tags))
    ORDER BY
      CASE WHEN :sort = 'name' THEN s.name END ASC,
      s.updated_at DESC
    LIMIT :limit OFFSET :offset
    """
)

MCP_SPEC = ResourceSpec(
    resource_type="mcp",
    target_type="mcp_server",
    load_sql=SELECT_SERVER,
    load_param="server_id",
    update_status_sql=text(
        "UPDATE mcp_servers SET status = :status, disabled_reason = :reason, "
        "status_revision = nextval('resource_status_revision_seq') WHERE id = :id"
    ),
    mark_deleted_sql=text(
        "UPDATE mcp_servers SET status = 'deleted', status_revision = nextval('resource_status_revision_seq') "
        "WHERE id = :id"
    ),
    not_found_message="MCP server 不存在",
    disabled_message="MCP server 已停用",
)


@router.post("/teams/{team_id}/mcp-servers", status_code=201)
async def create_server(
    team_id: UUID,
    payload: McpServerCreateIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    access = await require_team_access(session, actor, team_id)
    name = payload.name.strip()
    if not name:
        raise AppError(ErrorCode.VALIDATION_FAILED, "name 不能为空")
    _validate_version_payload(payload)
    duplicate = (
        await session.execute(
            text(
                "SELECT 1 FROM mcp_servers WHERE team_id = :team_id AND slug = :slug AND status <> 'deleted'"
            ),
            {"team_id": team_id, "slug": name},
        )
    ).first()
    if duplicate is not None:
        raise AppError(ErrorCode.CONFLICT, "该团队已存在同名 MCP server，请使用提交新版本接口")

    server_row = (
        await session.execute(
            text(
                """
                INSERT INTO mcp_servers (org_id, team_id, name, slug, description, tags, created_by)
                VALUES (:org_id, :team_id, :name, :slug, :description, :tags, :created_by)
                RETURNING id, status
                """
            ),
            {
                "org_id": access.org_id,
                "team_id": team_id,
                "name": name,
                "slug": name,
                "description": payload.description.strip(),
                "tags": list(dict.fromkeys(tag.strip() for tag in payload.tags if tag.strip()))[:20],
                "created_by": actor.user_id,
            },
        )
    ).mappings().one()
    return await _submit_version(
        session,
        actor,
        request,
        team_id=team_id,
        org_id=access.org_id,
        server_id=server_row["id"],
        name=name,
        payload=payload,
    )


@router.post("/mcp-servers/{server_id}/versions", status_code=201)
async def create_version(
    server_id: UUID,
    payload: McpVersionIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    server = await _load_server(session, server_id)
    await require_team_access(session, actor, server["team_id"])
    if server["status"] == "disabled":
        raise AppError(ErrorCode.CONFLICT, "资源已停用，无法提交新版本")
    _validate_version_payload(payload)
    return await _submit_version(
        session,
        actor,
        request,
        team_id=server["team_id"],
        org_id=server["org_id"],
        server_id=server_id,
        name=str(server["name"]),
        payload=payload,
    )


@router.get("/teams/{team_id}/mcp-servers", response_model=McpServerListOut)
async def list_team_servers(
    team_id: UUID,
    actor: ActorDep,
    session: SessionDep,
    status: str = Query(default=""),
    q: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> McpServerListOut:
    await require_team_access(session, actor, team_id)
    rows = (
        await session.execute(
            SELECT_TEAM_SERVERS,
            {"team_id": team_id, "status": status, "q": q, "limit": limit, "offset": offset},
        )
    ).mappings().all()
    return McpServerListOut(items=[_server_out(row) for row in rows], total=len(rows))


@router.get("/mcp-servers/{server_id}", response_model=McpServerDetailOut)
async def get_server(server_id: UUID, actor: ActorDep, session: SessionDep) -> McpServerDetailOut:
    server = await _load_server(session, server_id)
    access = await require_team_access(session, actor, server["team_id"])
    if server["status"] in {"delisted", "disabled"} and not access.is_admin:
        raise AppError(ErrorCode.NOT_FOUND, "资源不可见")
    versions = (
        await session.execute(SELECT_VERSIONS, {"server_id": server_id})
    ).mappings().all()
    latest = next((row for row in versions if row["status"] == "published"), None)
    config_template: dict[str, object] = {}
    env_schema: list[McpEnvField] = []
    docs_md = ""
    if latest is not None:
        full = (
            await session.execute(
                text(
                    "SELECT config_template, env_schema, docs_md FROM mcp_server_versions WHERE id = :id"
                ),
                {"id": latest["id"]},
            )
        ).mappings().one()
        config_template = _as_dict(full["config_template"])
        env_schema = [McpEnvField(**dict(item)) for item in _as_list(full["env_schema"])]
        docs_md = str(full["docs_md"] or "")
    return McpServerDetailOut(
        **_server_out(
            {
                "id": server["id"],
                "org_id": server["org_id"],
                "team_id": server["team_id"],
                "name": server["name"],
                "description": server["description"],
                "tags": server["tags"],
                "status": server["status"],
                "status_revision": server["status_revision"],
                "latest_version": latest["version"] if latest else None,
                "updated_at": server["updated_at"],
            }
        ).model_dump(),
        disabled_reason=server["disabled_reason"],
        config_template=config_template,
        env_schema=env_schema,
        docs_md=docs_md,
        versions=[McpVersionOut(**dict(row)) for row in versions],
    )


@router.post("/mcp-servers/{server_id}:delist")
async def delist_server(
    server_id: UUID, actor: ActorDep, request: Request, session: SessionDep
) -> dict[str, object]:
    return await _set_server_status(session, actor, request, server_id, "delisted", admin_required=True)


@router.post("/mcp-servers/{server_id}:publish")
async def publish_server(
    server_id: UUID, actor: ActorDep, request: Request, session: SessionDep
) -> dict[str, object]:
    server = await _load_server(session, server_id)
    if server["latest_published_version_id"] is None:
        raise AppError(ErrorCode.CONFLICT, "没有可发布的版本")
    return await _set_server_status(session, actor, request, server_id, "published", admin_required=True)


@router.post("/mcp-servers/{server_id}:disable")
async def disable_server(
    server_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    reason: str = Query(default=""),
) -> dict[str, object]:
    if not reason.strip():
        raise AppError(ErrorCode.VALIDATION_FAILED, "停用必须填写原因")
    result = await _set_server_status(
        session, actor, request, server_id, "disabled", admin_required=True, reason=reason
    )
    server = await _load_server(session, server_id, include_disabled=True)
    affected = await notify_activation_users(
        session,
        resource_type="mcp",
        ref_id=server_id,
        kind="mcp.disabled",
        params={"name": server["name"], "reason": reason},
        payload={"mcpServerId": str(server_id), "reason": reason},
    )
    await session.commit()
    return {**result, "notified": affected}


@router.post("/mcp-servers/{server_id}:enable")
async def enable_server(
    server_id: UUID, actor: ActorDep, request: Request, session: SessionDep
) -> dict[str, object]:
    return await _set_server_status(session, actor, request, server_id, "published", admin_required=True)


@router.delete("/mcp-servers/{server_id}")
async def delete_server(
    server_id: UUID, actor: ActorDep, request: Request, session: SessionDep
) -> dict[str, object]:
    async def notify(row: RowMapping) -> int:
        return await notify_activation_users(
            session,
            resource_type="mcp",
            ref_id=server_id,
            kind="mcp.deleted",
            params={"name": row["name"]},
            payload={"mcpServerId": str(server_id)},
        )

    return await delete_resource(session, actor, request, MCP_SPEC, server_id, notify)


@router.post("/mcp-servers/{server_id}/versions/{version}:revoke")
async def revoke_version(
    server_id: UUID,
    version: int,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    reason: str = Query(default=""),
) -> dict[str, object]:
    if not reason.strip():
        raise AppError(ErrorCode.VALIDATION_FAILED, "撤回版本必须填写原因")
    server = await _load_server(session, server_id)
    await require_team_access(session, actor, server["team_id"], admin=True)
    row = (
        await session.execute(SELECT_VERSION, {"server_id": server_id, "version": version})
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "版本不存在")
    await session.execute(
        text(
            "UPDATE mcp_server_versions SET status = 'revoked', revoked_reason = :reason WHERE id = :id"
        ),
        {"id": row["id"], "reason": reason},
    )
    # 撤回最新已发布版本时，latest 指针回退到可用的上一版（与 Skill 一致）
    replacement_row = (
        await session.execute(
            text(
                """
                SELECT id, version FROM mcp_server_versions
                WHERE mcp_server_id = :server_id AND status IN ('published', 'superseded') AND id <> :id
                ORDER BY version DESC LIMIT 1
                """
            ),
            {"server_id": server_id, "id": row["id"]},
        )
    ).mappings().first()
    current_latest = (
        await session.execute(
            text("SELECT latest_published_version_id FROM mcp_servers WHERE id = :id"),
            {"id": server_id},
        )
    ).scalar_one()
    if current_latest == row["id"] and replacement_row is not None:
        await session.execute(
            text("UPDATE mcp_servers SET latest_published_version_id = :version_id WHERE id = :id"),
            {"id": server_id, "version_id": replacement_row["id"]},
        )
    await session.execute(
        text("UPDATE mcp_servers SET status_revision = nextval('resource_status_revision_seq') WHERE id = :id"),
        {"id": server_id},
    )
    replacement = replacement_row["version"] if replacement_row is not None else None
    affected = await notify_activation_users(
        session,
        resource_type="mcp",
        ref_id=server_id,
        kind="mcp.version_revoked",
        params={
            "name": server["name"],
            "version": version,
            "reason": reason,
            "replacement": replacement,
        },
        payload={
            "mcpServerId": str(server_id),
            "version": version,
            "replacementVersion": str(replacement) if replacement is not None else None,
            "reason": reason,
        },
    )
    await record_audit(
        session,
        action="mcp.revoke_version",
        actor_id=actor.user_id,
        org_id=server["org_id"],
        target_type="mcp_server_version",
        target_id=str(row["id"]),
        detail={"version": version, "reason": reason, "affectedUsers": affected},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {
        "id": str(row["id"]),
        "status": "revoked",
        "replacementVersion": str(replacement) if replacement is not None else None,
        "notified": affected,
    }


@router.get("/marketplace/mcp-servers", response_model=McpServerListOut)
async def marketplace(
    actor: ActorDep,
    session: SessionDep,
    q: str = Query(default=""),
    tag: str = Query(default=""),
    sort: Literal["updated", "name"] = Query(default="updated"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> McpServerListOut:
    team_ids = await team_ids_for_user(session, actor.user_id)
    if not team_ids:
        return McpServerListOut(items=[], total=0)
    rows = (
        await session.execute(
            MARKETPLACE,
            {"team_ids": team_ids, "q": q, "tag": tag, "sort": sort, "limit": limit, "offset": offset},
        )
    ).mappings().all()
    return McpServerListOut(items=[_server_out(row) for row in rows], total=len(rows))


async def _submit_version(
    session: AsyncSession,
    actor: Actor,
    request: Request,
    *,
    team_id: UUID,
    org_id: UUID,
    server_id: UUID,
    name: str,
    payload: McpVersionIn,
) -> dict[str, object]:
    pending = (
        await session.execute(
            text("SELECT 1 FROM mcp_server_versions WHERE mcp_server_id = :id AND status = 'pending'"),
            {"id": server_id},
        )
    ).first()
    if pending is not None:
        raise AppError(ErrorCode.CONFLICT, "该 MCP server 已有待审批版本，请先撤回或等待审批")

    version = (
        await session.execute(
            text(
                "SELECT COALESCE(MAX(version), 0) + 1 FROM mcp_server_versions WHERE mcp_server_id = :id"
            ),
            {"id": server_id},
        )
    ).scalar_one()
    version_row = (
        await session.execute(
            text(
                """
                INSERT INTO mcp_server_versions
                    (mcp_server_id, version, transport, config_template, env_schema, docs_md, changelog, created_by)
                VALUES (:server_id, :version, :transport, CAST(:config_template AS jsonb),
                        CAST(:env_schema AS jsonb), :docs_md, :changelog, :created_by)
                RETURNING id, status
                """
            ),
            {
                "server_id": server_id,
                "version": version,
                "transport": payload.transport,
                "config_template": json.dumps(payload.config_template, ensure_ascii=False),
                "env_schema": json.dumps(
                    [field.model_dump(by_alias=False, exclude_none=True) for field in payload.env_schema],
                    ensure_ascii=False,
                ),
                "docs_md": payload.docs_md or None,
                "changelog": payload.changelog or None,
                "created_by": actor.user_id,
            },
        )
    ).mappings().one()

    approval = (
        await session.execute(
            text(
                """
                INSERT INTO approval_requests (type, requester_id, org_id, team_id, target_type, target_id, payload)
                VALUES ('mcp_version_publish', :requester_id, :org_id, :team_id, 'mcp_server_version',
                        :target_id, CAST(:payload AS jsonb))
                RETURNING id
                """
            ),
            {
                "requester_id": actor.user_id,
                "org_id": org_id,
                "team_id": team_id,
                "target_id": str(version_row["id"]),
                "payload": json.dumps(
                    {
                        "mcpServerId": str(server_id),
                        "version": version,
                        "name": name,
                        "transport": payload.transport,
                        "envKeys": [field.key for field in payload.env_schema],
                    },
                    ensure_ascii=False,
                ),
            },
        )
    ).scalar_one()
    await session.execute(
        text("UPDATE mcp_server_versions SET review_id = :review_id WHERE id = :id"),
        {"review_id": approval, "id": version_row["id"]},
    )
    await notify_team_admins(
        session,
        team_id,
        kind="approval.mcp_version_publish",
        params={"name": name, "version": version, "actor": actor.display_name},
        payload={"approvalId": str(approval), "mcpServerId": str(server_id), "version": version},
    )
    await record_audit(
        session,
        action="mcp.version.submit",
        actor_id=actor.user_id,
        org_id=org_id,
        target_type="mcp_server_version",
        target_id=str(version_row["id"]),
        detail={"mcpServerId": str(server_id), "version": version, "transport": payload.transport},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {
        "mcpServerId": str(server_id),
        "versionId": str(version_row["id"]),
        "version": version,
        "status": version_row["status"],
        "approvalId": str(approval),
    }


async def _set_server_status(
    session: AsyncSession,
    actor: Actor,
    request: Request,
    server_id: UUID,
    status: str,
    *,
    admin_required: bool,
    reason: str | None = None,
) -> dict[str, object]:
    return await set_resource_status(
        session, actor, request, MCP_SPEC, server_id, status, admin_required=admin_required, reason=reason
    )


async def _load_server(
    session: AsyncSession, server_id: UUID, *, include_disabled: bool = False
) -> RowMapping:
    return await load_resource(session, MCP_SPEC, {"server_id": server_id}, include_disabled=include_disabled)


def _validate_version_payload(payload: McpVersionIn) -> None:
    template = payload.config_template
    if payload.transport == "stdio":
        command = template.get("command")
        if not isinstance(command, str) or not command.strip():
            raise AppError(ErrorCode.VALIDATION_FAILED, "stdio 传输的 config_template 必须包含 command")
    else:
        url = template.get("url")
        if not isinstance(url, str) or not url.strip():
            raise AppError(ErrorCode.VALIDATION_FAILED, f"{payload.transport} 传输的 config_template 必须包含 url")
    if len(payload.docs_md) > MAX_DOCS_MD:
        raise AppError(ErrorCode.VALIDATION_FAILED, f"docs_md 超过长度上限（{MAX_DOCS_MD} 字符）")
    if len(payload.env_schema) > MAX_ENV_FIELDS:
        raise AppError(ErrorCode.VALIDATION_FAILED, f"env_schema 最多 {MAX_ENV_FIELDS} 项")
    seen: set[str] = set()
    for field in payload.env_schema:
        key = field.key.strip()
        if not ENV_KEY_PATTERN.match(key):
            raise AppError(ErrorCode.VALIDATION_FAILED, f"环境变量名不合法：{key}")
        if key in seen:
            raise AppError(ErrorCode.VALIDATION_FAILED, f"环境变量重复：{key}")
        seen.add(key)
        if not field.label.strip():
            raise AppError(ErrorCode.VALIDATION_FAILED, f"{key} 缺少展示名称")


def _server_out(row: Any) -> McpServerOut:
    return McpServerOut(
        id=row["id"],
        org_id=row["org_id"],
        team_id=row["team_id"],
        name=str(row["name"]),
        description=str(row["description"]),
        tags=list(row["tags"] or []),
        status=str(row["status"]),
        status_revision=int(row["status_revision"]),
        latest_version=int(row["latest_version"]) if row["latest_version"] is not None else None,
        updated_at=row["updated_at"],
    )


def _as_dict(value: object) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        parsed = json.loads(value)
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _as_list(value: object) -> list[dict[str, object]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if isinstance(value, str):
        parsed = json.loads(value)
        return [item for item in parsed if isinstance(item, dict)] if isinstance(parsed, list) else []
    return []
