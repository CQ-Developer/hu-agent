"""工作空间云同步服务端（design 6.6 / 5.11）：关联、快照乐观锁、预签名直传、配额与保留。

- 仅 owner 可读写；团队管理员只能看到存储用量（D12：工作空间个人所有）
- 快照不可变；`snapshots:init` 用 baseVersion 做乐观锁，冲突返回 409 + 最新版本
- 上传完成后 `complete` 校验对象存在、大小与 sha256；失败删对象并置 aborted
- 配额取用户总量与团队总量的交集；团队归档/组织冻结时上传只读
"""

from __future__ import annotations

import json
import uuid as uuid_module
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.rbac import get_team_access
from huagent.domain.settings import get_int_setting
from huagent.storage.objects import get_object_store

router = APIRouter(tags=["workspaces"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]


class WorkspaceCreateIn(ApiModel):
    name: str
    team_id: UUID | None = None
    device_id: str | None = None


class WorkspaceOut(ApiModel):
    id: UUID
    name: str
    team_id: UUID | None
    status: str
    latest_version: int | None = None
    storage_bytes: int
    created_at: datetime


class SnapshotInitIn(ApiModel):
    base_version: int
    size_bytes: int
    file_count: int
    manifest_digest: str
    comment: str | None = None
    # 文件清单（相对路径 + 大小），用于冲突时导出差异；服务端不校验内容
    manifest: list[dict[str, object]] | None = None


class SnapshotInitOut(ApiModel):
    snapshot_id: UUID
    version: int
    upload_url: str
    expires_in: int


class SnapshotOut(ApiModel):
    id: UUID
    workspace_id: UUID
    version: int
    status: str
    digest: str | None
    manifest_digest: str | None
    size_bytes: int
    file_count: int
    device_id: str | None
    comment: str | None
    pinned: bool
    created_at: datetime
    manifest: list[dict[str, object]] | None = None


class SnapshotListOut(ApiModel):
    items: list[SnapshotOut]
    total: int


class SnapshotCompleteIn(ApiModel):
    digest: str


class QuotaOut(ApiModel):
    used_bytes: int
    limit_bytes: int
    user_used_bytes: int
    user_limit_bytes: int
    team_used_bytes: int | None
    team_limit_bytes: int | None


SELECT_WORKSPACE = text(
    """
    SELECT w.id, w.user_id, w.team_id, w.name, w.status, w.latest_snapshot_id, w.storage_bytes, w.created_at,
           t.status AS team_status, o.status AS org_status
    FROM workspaces w
    LEFT JOIN teams t ON t.id = w.team_id
    LEFT JOIN orgs o ON o.id = t.org_id
    WHERE w.id = :workspace_id AND w.status <> 'archived'
    """
)

SELECT_MY_WORKSPACES = text(
    """
    SELECT w.id, w.name, w.team_id, w.status, w.storage_bytes, w.created_at,
           (SELECT version FROM workspace_snapshots s WHERE s.id = w.latest_snapshot_id) AS latest_version
    FROM workspaces w WHERE w.user_id = :user_id AND w.status <> 'archived'
    ORDER BY w.created_at
    """
)

INSERT_WORKSPACE = text(
    """
    INSERT INTO workspaces (user_id, team_id, name)
    VALUES (:user_id, :team_id, :name)
    RETURNING id, name, team_id, status, storage_bytes, created_at
    """
)

SELECT_LATEST_SNAPSHOT = text(
    """
    SELECT id, version FROM workspace_snapshots
    WHERE workspace_id = :workspace_id AND status = 'active'
    ORDER BY version DESC LIMIT 1
    """
)

SELECT_MAX_SNAPSHOT_VERSION = text(
    "SELECT COALESCE(MAX(version), 0) FROM workspace_snapshots WHERE workspace_id = :workspace_id"
)

INSERT_SNAPSHOT = text(
    """
    INSERT INTO workspace_snapshots (workspace_id, version, status, object_key, size_bytes, file_count,
                                     manifest_digest, device_id, comment, manifest)
    VALUES (:workspace_id, :version, 'uploading', :object_key, :size_bytes, :file_count,
            :manifest_digest, :device_id, :comment, CAST(:manifest AS jsonb))
    RETURNING id
    """
)

SELECT_SNAPSHOT = text(
    """
    SELECT id, workspace_id, version, status, object_key, digest, manifest_digest, size_bytes, file_count,
           device_id, comment, pinned, created_at
    FROM workspace_snapshots WHERE id = :snapshot_id
    """
)

LIST_SNAPSHOTS = text(
    """
    SELECT id, workspace_id, version, status, digest, manifest_digest, size_bytes, file_count,
           device_id, comment, pinned, created_at
    FROM workspace_snapshots WHERE workspace_id = :workspace_id AND status <> 'aborted'
    ORDER BY version DESC LIMIT :limit OFFSET :offset
    """
)

COUNT_SNAPSHOTS = text(
    "SELECT count(*) FROM workspace_snapshots WHERE workspace_id = :workspace_id AND status <> 'aborted'"
)

COMPLETE_SNAPSHOT = text(
    """
    UPDATE workspace_snapshots SET status = 'active', digest = :digest
    WHERE id = :snapshot_id AND status = 'uploading'
    RETURNING id
    """
)

ABORT_SNAPSHOT = text("UPDATE workspace_snapshots SET status = 'aborted' WHERE id = :snapshot_id")

SUM_USER_STORAGE = text(
    """
    SELECT COALESCE(SUM(s.size_bytes), 0) FROM workspace_snapshots s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE w.user_id = :user_id AND s.status = 'active'
    """
)

SUM_TEAM_STORAGE = text(
    """
    SELECT COALESCE(SUM(s.size_bytes), 0) FROM workspace_snapshots s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE w.team_id = :team_id AND s.status = 'active'
    """
)

RECOMPUTE_WORKSPACE_STORAGE = text(
    """
    UPDATE workspaces SET storage_bytes = COALESCE((
      SELECT SUM(size_bytes) FROM workspace_snapshots
      WHERE workspace_id = :workspace_id AND status = 'active'
    ), 0), latest_snapshot_id = (
      SELECT id FROM workspace_snapshots
      WHERE workspace_id = :workspace_id AND status = 'active' ORDER BY version DESC LIMIT 1
    )
    WHERE id = :workspace_id
    """
)


@router.post("/workspaces", status_code=201, response_model=WorkspaceOut)
async def create_workspace(
    payload: WorkspaceCreateIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> WorkspaceOut:
    name = payload.name.strip()
    if not 1 <= len(name) <= 120:
        raise AppError(ErrorCode.VALIDATION_FAILED, "工作空间名称长度需在 1-120 之间")
    if payload.team_id is not None:
        access = await get_team_access(session, actor.user_id, payload.team_id)
        if access is None or not access.is_member:
            raise AppError(ErrorCode.NOT_FOUND, "团队不存在或无权访问")
    row = (
        await session.execute(
            INSERT_WORKSPACE,
            {"user_id": actor.user_id, "team_id": payload.team_id, "name": name},
        )
    ).mappings().one()
    await record_audit(
        session,
        action="workspace.create",
        actor_id=actor.user_id,
        target_type="workspace",
        target_id=str(row["id"]),
        detail={"name": name, "teamId": str(payload.team_id) if payload.team_id else None},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return WorkspaceOut(**dict(row))


@router.get("/workspaces", response_model=list[WorkspaceOut])
async def list_workspaces(actor: ActorDep, session: SessionDep) -> list[WorkspaceOut]:
    rows = (await session.execute(SELECT_MY_WORKSPACES, {"user_id": actor.user_id})).mappings().all()
    return [WorkspaceOut(**dict(row)) for row in rows]


@router.get("/workspaces/{workspace_id}/snapshots", response_model=SnapshotListOut)
async def list_snapshots(
    workspace_id: UUID,
    actor: ActorDep,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> SnapshotListOut:
    await _require_owner(session, actor, workspace_id)
    rows = (
        await session.execute(
            LIST_SNAPSHOTS, {"workspace_id": workspace_id, "limit": limit, "offset": offset}
        )
    ).mappings().all()
    total = int((await session.execute(COUNT_SNAPSHOTS, {"workspace_id": workspace_id})).scalar_one())
    return SnapshotListOut(items=[_snapshot_out(row) for row in rows], total=total)


@router.get("/workspaces/{workspace_id}/snapshots/latest", response_model=SnapshotOut)
async def latest_snapshot(
    workspace_id: UUID,
    actor: ActorDep,
    session: SessionDep,
    with_manifest: Annotated[bool, Query(alias="withManifest")] = False,
) -> SnapshotOut:
    await _require_owner(session, actor, workspace_id)
    row = (
        await session.execute(
            text(
                """
                SELECT id, workspace_id, version, status, digest, manifest_digest, size_bytes, file_count,
                       device_id, comment, pinned, created_at, manifest
                FROM workspace_snapshots WHERE workspace_id = :workspace_id AND status = 'active'
                ORDER BY version DESC LIMIT 1
                """
            ),
            {"workspace_id": workspace_id},
        )
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "该工作空间还没有快照")
    return _snapshot_out(row, with_manifest=with_manifest)


@router.get("/workspaces/{workspace_id}/quota", response_model=QuotaOut)
async def workspace_quota(workspace_id: UUID, actor: ActorDep, session: SessionDep) -> QuotaOut:
    workspace = await _require_owner(session, actor, workspace_id)
    return await _quota_snapshot(session, actor.user_id, workspace["team_id"])


@router.post("/workspaces/{workspace_id}/snapshots:init", response_model=SnapshotInitOut)
async def init_snapshot(
    workspace_id: UUID,
    payload: SnapshotInitIn,
    actor: ActorDep,
    session: SessionDep,
) -> SnapshotInitOut:
    settings = get_settings()
    workspace = await _require_owner(session, actor, workspace_id)

    # 团队归档 / 组织冻结：只读（下载不受限）
    if workspace["team_status"] is not None and workspace["team_status"] != "active":
        raise AppError(ErrorCode.FORBIDDEN, "团队已归档，快照为只读")
    if workspace["org_status"] is not None and workspace["org_status"] != "active":
        raise AppError(ErrorCode.FORBIDDEN, "组织已冻结，快照为只读")

    if payload.size_bytes > settings.snapshot_max_bytes:
        raise AppError(
            ErrorCode.VALIDATION_FAILED,
            f"单快照超过上限（{settings.snapshot_max_bytes // (1024 * 1024 * 1024)} GB），请使用排除规则",
        )
    if payload.file_count > settings.snapshot_max_files:
        raise AppError(ErrorCode.VALIDATION_FAILED, f"文件数超过上限（{settings.snapshot_max_files}）")

    latest = (
        await session.execute(SELECT_LATEST_SNAPSHOT, {"workspace_id": workspace_id})
    ).mappings().first()
    latest_version = int(latest["version"]) if latest is not None else 0
    if payload.base_version != latest_version:
        raise AppError(
            ErrorCode.VERSION_CONFLICT,
            "服务端已有更新的版本，请先拉取",
            details={"latestVersion": latest_version},
        )

    quota = await _quota_snapshot(session, actor.user_id, workspace["team_id"])
    if quota.used_bytes + payload.size_bytes > quota.limit_bytes:
        raise AppError(
            ErrorCode.QUOTA_EXCEEDED,
            "存储配额不足",
            details={"usedBytes": quota.used_bytes, "limitBytes": quota.limit_bytes},
        )

    version = int((await session.execute(SELECT_MAX_SNAPSHOT_VERSION, {"workspace_id": workspace_id})).scalar_one()) + 1
    object_key = f"snapshots/{actor.user_id}/{workspace_id}/{version}/{uuid_module.uuid7().hex}.zip"
    snapshot_id = (
        await session.execute(
            INSERT_SNAPSHOT,
            {
                "workspace_id": workspace_id,
                "version": version,
                "object_key": object_key,
                "size_bytes": payload.size_bytes,
                "file_count": payload.file_count,
                "manifest_digest": payload.manifest_digest,
                "device_id": actor.device_id,
                "comment": payload.comment,
                "manifest": json.dumps(payload.manifest or [], ensure_ascii=False),
            },
        )
    ).scalar_one()
    upload_url = get_object_store().presign_put(object_key, settings.snapshot_upload_url_ttl_seconds)
    await session.commit()
    return SnapshotInitOut(
        snapshot_id=snapshot_id,
        version=version,
        upload_url=upload_url,
        expires_in=settings.snapshot_upload_url_ttl_seconds,
    )


@router.post("/snapshots/{snapshot_id}:complete", response_model=SnapshotOut)
async def complete_snapshot(
    snapshot_id: UUID,
    payload: SnapshotCompleteIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> SnapshotOut:
    snapshot = await _require_snapshot_owner(session, actor, snapshot_id)
    if snapshot["status"] != "uploading":
        raise AppError(ErrorCode.CONFLICT, f"快照状态为 {snapshot['status']}，无法完成")
    store = get_object_store()
    if not store.exists(str(snapshot["object_key"])):
        raise AppError(ErrorCode.VALIDATION_FAILED, "上传对象不存在或已过期，请重新上传")

    actual_digest, actual_size = store.digest(str(snapshot["object_key"]))
    if actual_digest != payload.digest or actual_size != int(snapshot["size_bytes"]):
        store.delete(str(snapshot["object_key"]))
        await session.execute(ABORT_SNAPSHOT, {"snapshot_id": snapshot_id})
        await session.commit()
        raise AppError(
            ErrorCode.PACKAGE_INVALID,
            "快照校验失败（sha256 或大小与清单不一致），已删除上传对象",
            details={"actualDigest": actual_digest, "actualSize": actual_size},
        )

    await session.execute(COMPLETE_SNAPSHOT, {"snapshot_id": snapshot_id, "digest": payload.digest})
    await session.execute(RECOMPUTE_WORKSPACE_STORAGE, {"workspace_id": snapshot["workspace_id"]})
    await record_audit(
        session,
        action="snapshot.complete",
        actor_id=actor.user_id,
        target_type="snapshot",
        target_id=str(snapshot_id),
        detail={"version": snapshot["version"], "sizeBytes": actual_size},
        actor_ip=client_ip(request),
    )
    await session.commit()
    refreshed = (
        await session.execute(SELECT_SNAPSHOT, {"snapshot_id": snapshot_id})
    ).mappings().one()
    return _snapshot_out(refreshed)


@router.get("/snapshots/{snapshot_id}/download-url")
async def download_url(
    snapshot_id: UUID,
    actor: ActorDep,
    session: SessionDep,
) -> dict[str, object]:
    snapshot = await _require_snapshot_owner(session, actor, snapshot_id)
    if snapshot["status"] != "active":
        raise AppError(ErrorCode.CONFLICT, "快照未完成上传，暂不可下载")
    ttl = get_settings().snapshot_download_url_ttl_seconds
    return {
        "url": get_object_store().presign_get(str(snapshot["object_key"]), ttl),
        "expiresIn": ttl,
        "digest": snapshot["digest"],
        "version": snapshot["version"],
    }


@router.post("/snapshots/{snapshot_id}:pin", response_model=SnapshotOut)
async def pin_snapshot(snapshot_id: UUID, actor: ActorDep, session: SessionDep) -> SnapshotOut:
    await _require_snapshot_owner(session, actor, snapshot_id)
    await session.execute(
        text("UPDATE workspace_snapshots SET pinned = true WHERE id = :id"), {"id": snapshot_id}
    )
    await session.commit()
    row = (await session.execute(SELECT_SNAPSHOT, {"snapshot_id": snapshot_id})).mappings().one()
    return _snapshot_out(row)


@router.delete("/snapshots/{snapshot_id}")
async def delete_snapshot(
    snapshot_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> dict[str, object]:
    snapshot = await _require_snapshot_owner(session, actor, snapshot_id)
    if snapshot["pinned"]:
        raise AppError(ErrorCode.CONFLICT, "该版本已标记永久保留，请先取消保留")
    workspace = (
        await session.execute(SELECT_WORKSPACE, {"workspace_id": snapshot["workspace_id"]})
    ).mappings().one()
    if workspace["latest_snapshot_id"] == snapshot_id:
        raise AppError(ErrorCode.CONFLICT, "不能删除最新版本")

    get_object_store().delete(str(snapshot["object_key"]))
    await session.execute(text("DELETE FROM workspace_snapshots WHERE id = :id"), {"id": snapshot_id})
    await session.execute(RECOMPUTE_WORKSPACE_STORAGE, {"workspace_id": snapshot["workspace_id"]})
    await record_audit(
        session,
        action="snapshot.delete",
        actor_id=actor.user_id,
        target_type="snapshot",
        target_id=str(snapshot_id),
        detail={"version": snapshot["version"]},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"id": str(snapshot_id), "deleted": True}


async def _require_owner(session: AsyncSession, actor: Actor, workspace_id: UUID) -> RowMapping:
    workspace = (
        await session.execute(SELECT_WORKSPACE, {"workspace_id": workspace_id})
    ).mappings().first()
    if workspace is None or workspace["user_id"] != actor.user_id:
        raise AppError(ErrorCode.NOT_FOUND, "工作空间不存在或不属于当前用户")
    return workspace


async def _require_snapshot_owner(session: AsyncSession, actor: Actor, snapshot_id: UUID) -> RowMapping:
    snapshot = (
        await session.execute(SELECT_SNAPSHOT, {"snapshot_id": snapshot_id})
    ).mappings().first()
    if snapshot is None:
        raise AppError(ErrorCode.NOT_FOUND, "快照不存在")
    await _require_owner(session, actor, snapshot["workspace_id"])
    return snapshot


async def _quota_snapshot(session: AsyncSession, user_id: UUID, team_id: UUID | None) -> QuotaOut:
    settings = get_settings()
    user_limit = await get_int_setting(session, "quota.user_bytes", settings.quota_user_bytes)
    team_limit = await get_int_setting(session, "quota.team_bytes", settings.quota_team_bytes)
    user_used = int((await session.execute(SUM_USER_STORAGE, {"user_id": user_id})).scalar_one())
    team_used = None
    limit = user_limit
    if team_id is not None:
        team_used = int((await session.execute(SUM_TEAM_STORAGE, {"team_id": team_id})).scalar_one())
        limit = min(user_limit, team_limit)
    return QuotaOut(
        used_bytes=user_used if team_id is None else max(user_used, team_used or 0),
        limit_bytes=limit,
        user_used_bytes=user_used,
        user_limit_bytes=user_limit,
        team_used_bytes=team_used,
        team_limit_bytes=team_limit if team_id is not None else None,
    )


def _snapshot_out(row: RowMapping, *, with_manifest: bool = False) -> SnapshotOut:
    manifest = row["manifest"] if with_manifest and "manifest" in row else None
    return SnapshotOut(
        id=row["id"],
        workspace_id=row["workspace_id"],
        version=int(row["version"]),
        status=str(row["status"]),
        digest=row["digest"],
        manifest_digest=row["manifest_digest"],
        size_bytes=int(row["size_bytes"]),
        file_count=int(row["file_count"]),
        device_id=row["device_id"],
        comment=row["comment"],
        pinned=bool(row["pinned"]),
        created_at=row["created_at"],
        manifest=manifest if isinstance(manifest, list) else None,
    )
