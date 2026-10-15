"""Skill 市场服务端（design 6.4 / 6.9.2）。

上传使用原始 zip 请求体（`application/zip`），服务端边收边限流校验；
包落对象存储，元数据与版本入 DB，发布需团队管理员审批（审批流在 approvals.py）。
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.config import Settings, get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.notifications import notify_activation_users, notify_team_admins
from huagent.domain.packages import (
    PackageInvalidError,
    ValidatedPackage,
    package_manifest,
    validate_skill_package,
)
from huagent.domain.rbac import require_team_access, team_ids_for_user
from huagent.domain.resource_admin import ResourceSpec, delete_resource, load_resource, set_resource_status
from huagent.storage.objects import get_object_store

router = APIRouter(tags=["skills"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]

DOWNLOAD_URL_TTL_SECONDS = 300
MAX_SKILL_MD_PREVIEW = 20_000


class SkillOut(ApiModel):
    id: UUID
    org_id: UUID
    team_id: UUID
    name: str
    description: str
    tags: list[str]
    status: str
    status_revision: int
    latest_version: str | None
    download_count: int = 0
    updated_at: datetime


class SkillVersionOut(ApiModel):
    id: UUID
    version: str
    status: str
    digest: str
    size_bytes: int
    file_count: int
    changelog: str | None
    download_count: int
    created_at: datetime


class SkillDetailOut(SkillOut):
    disabled_reason: str | None = None
    manifest: dict[str, object]
    skill_md: str
    versions: list[SkillVersionOut]


class SkillListOut(ApiModel):
    items: list[SkillOut]
    total: int


class DownloadUrlOut(ApiModel):
    url: str
    expires_in: int
    digest: str
    version: str


SELECT_TEAM_SKILLS = text(
    """
    SELECT s.id, s.org_id, s.team_id, s.name, s.description, s.tags, s.status, s.status_revision,
           v.version AS latest_version, COALESCE(v.download_count, 0) AS download_count, s.updated_at
    FROM skills s
    LEFT JOIN skill_versions v ON v.id = s.latest_published_version_id
    WHERE s.team_id = :team_id AND s.status <> 'deleted'
      AND (:status = '' OR s.status = :status)
      AND (:q = '' OR s.name ILIKE '%' || :q || '%' OR s.description ILIKE '%' || :q || '%')
    ORDER BY s.updated_at DESC LIMIT :limit OFFSET :offset
    """
)

SELECT_SKILL = text(
    """
    SELECT id, org_id, team_id, name, description, tags, status, status_revision, disabled_reason,
           latest_published_version_id, updated_at, created_by
    FROM skills WHERE id = :skill_id AND status <> 'deleted'
    """
)

SELECT_VERSIONS = text(
    """
    SELECT id, version, status, digest, size_bytes, file_count, changelog, download_count, created_at
    FROM skill_versions WHERE skill_id = :skill_id ORDER BY created_at DESC
    """
)

SELECT_VERSION = text(
    """
    SELECT id, skill_id, version, status, digest, object_key, size_bytes, file_count, manifest
    FROM skill_versions WHERE skill_id = :skill_id AND version = :version
    """
)

MARKETPLACE = text(
    """
    SELECT s.id, s.org_id, s.team_id, s.name, s.description, s.tags, s.status, s.status_revision,
           v.version AS latest_version, COALESCE(v.download_count, 0) AS download_count, s.updated_at
    FROM skills s
    LEFT JOIN skill_versions v ON v.id = s.latest_published_version_id
    WHERE s.team_id = ANY(:team_ids) AND s.status = 'published'
      AND (:q = '' OR s.name ILIKE '%' || :q || '%' OR s.description ILIKE '%' || :q || '%')
      AND (:tag = '' OR :tag = ANY(s.tags))
    ORDER BY
      CASE WHEN :sort = 'name' THEN s.name END ASC,
      CASE WHEN :sort = 'downloads' THEN COALESCE(v.download_count, 0) END DESC,
      CASE WHEN :sort = 'updated' THEN s.updated_at END DESC,
      s.updated_at DESC
    LIMIT :limit OFFSET :offset
    """
)

SKILL_SPEC = ResourceSpec(
    resource_type="skill",
    target_type="skill",
    load_sql=SELECT_SKILL,
    load_param="skill_id",
    update_status_sql=text(
        "UPDATE skills SET status = :status, disabled_reason = :reason, "
        "status_revision = nextval('resource_status_revision_seq') WHERE id = :id"
    ),
    mark_deleted_sql=text(
        "UPDATE skills SET status = 'deleted', status_revision = nextval('resource_status_revision_seq') "
        "WHERE id = :id"
    ),
    not_found_message="Skill 不存在",
    disabled_message="Skill 已停用",
)


@router.post("/teams/{team_id}/skills", status_code=201)
async def create_skill(
    team_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    changelog: str = Query(default=""),
) -> dict[str, object]:
    access = await require_team_access(session, actor, team_id)
    data = await read_body(request)
    settings = get_settings()
    package = _validate(data, settings)
    front = package.front_matter
    assert front is not None  # validate_skill_package 保证
    if front.version is None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "front matter 必须声明 version（semver）")

    duplicate = (
        await session.execute(
            text("SELECT 1 FROM skills WHERE team_id = :team_id AND slug = :slug AND status <> 'deleted'"),
            {"team_id": team_id, "slug": front.name},
        )
    ).first()
    if duplicate is not None:
        raise AppError(ErrorCode.CONFLICT, "该团队已存在同名 Skill，请使用上传新版本接口")

    skill_row = (
        await session.execute(
            text(
                """
                INSERT INTO skills (org_id, team_id, name, slug, description, tags, created_by)
                VALUES (:org_id, :team_id, :name, :slug, :description, :tags, :created_by)
                RETURNING id, status
                """
            ),
            {
                "org_id": access.org_id,
                "team_id": team_id,
                "name": front.name,
                "slug": front.name,
                "description": front.description,
                "tags": list(front.tags),
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
        skill_id=skill_row["id"],
        package=package,
        data=data,
        changelog=changelog,
    )


@router.post("/skills/{skill_id}/versions", status_code=201)
async def create_skill_version(
    skill_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    changelog: str = Query(default=""),
) -> dict[str, object]:
    skill = await _load_skill(session, skill_id)
    await require_team_access(session, actor, skill["team_id"])
    if skill["status"] == "disabled":
        raise AppError(ErrorCode.CONFLICT, "资源已停用，无法提交新版本")
    data = await read_body(request)
    package = _validate(data, get_settings())
    return await _submit_version(
        session,
        actor,
        request,
        team_id=skill["team_id"],
        org_id=skill["org_id"],
        skill_id=skill_id,
        package=package,
        data=data,
        changelog=changelog,
    )


@router.get("/teams/{team_id}/skills", response_model=SkillListOut)
async def list_team_skills(
    team_id: UUID,
    actor: ActorDep,
    session: SessionDep,
    status: str = Query(default=""),
    q: str = Query(default=""),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> SkillListOut:
    await require_team_access(session, actor, team_id)
    rows = (
        await session.execute(
            SELECT_TEAM_SKILLS,
            {"team_id": team_id, "status": status, "q": q, "limit": limit, "offset": offset},
        )
    ).mappings().all()
    return SkillListOut(items=[_skill_out(row) for row in rows], total=len(rows))


@router.get("/skills/{skill_id}", response_model=SkillDetailOut)
async def get_skill(skill_id: UUID, actor: ActorDep, session: SessionDep) -> SkillDetailOut:
    skill = await _load_skill(session, skill_id)
    access = await require_team_access(session, actor, skill["team_id"])
    if skill["status"] in {"delisted", "disabled"} and not access.is_admin:
        raise AppError(ErrorCode.NOT_FOUND, "资源不可见")
    versions = (
        await session.execute(SELECT_VERSIONS, {"skill_id": skill_id})
    ).mappings().all()
    latest = next((row for row in versions if row["status"] == "published"), None)
    detail_manifest: dict[str, object] = {}
    skill_md = ""
    if latest is not None:
        full = (
            await session.execute(
                text("SELECT manifest FROM skill_versions WHERE id = :id"), {"id": latest["id"]}
            )
        ).scalar_one()
        detail_manifest = full if isinstance(full, dict) else json.loads(full)
        skill_md = str(detail_manifest.get("skillMd") or "")
    return SkillDetailOut(
        **_skill_out(
            {
                "id": skill["id"],
                "org_id": skill["org_id"],
                "team_id": skill["team_id"],
                "name": skill["name"],
                "description": skill["description"],
                "tags": skill["tags"],
                "status": skill["status"],
                "status_revision": skill["status_revision"],
                "latest_version": latest["version"] if latest else None,
                "download_count": latest["download_count"] if latest else 0,
                "updated_at": skill["updated_at"],
            }
        ).model_dump(),
        disabled_reason=skill["disabled_reason"],
        manifest=detail_manifest,
        skill_md=skill_md,
        versions=[SkillVersionOut(**dict(row)) for row in versions],
    )


@router.get("/skills/{skill_id}/versions/{version}/download-url", response_model=DownloadUrlOut)
async def download_url(
    skill_id: UUID,
    version: str,
    actor: ActorDep,
    session: SessionDep,
) -> DownloadUrlOut:
    skill = await _load_skill(session, skill_id)
    await require_team_access(session, actor, skill["team_id"])
    if skill["status"] in {"delisted", "deleted", "disabled"}:
        raise AppError(ErrorCode.CONFLICT, "资源已下架或停用，不再提供下载")
    row = (
        await session.execute(SELECT_VERSION, {"skill_id": skill_id, "version": version})
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "版本不存在")
    if row["status"] not in {"published", "superseded", "revoked"}:
        raise AppError(ErrorCode.CONFLICT, "该版本尚未发布")
    if row["status"] == "revoked":
        raise AppError(ErrorCode.CONFLICT, "该版本已被撤回，请升级到最新版本")
    url = get_object_store().presign_get(str(row["object_key"]), DOWNLOAD_URL_TTL_SECONDS)
    await session.execute(
        text("UPDATE skill_versions SET download_count = download_count + 1 WHERE id = :id"),
        {"id": row["id"]},
    )
    await session.commit()
    return DownloadUrlOut(
        url=url,
        expires_in=DOWNLOAD_URL_TTL_SECONDS,
        digest=str(row["digest"]),
        version=str(row["version"]),
    )


@router.post("/skills/{skill_id}:delist")
async def delist_skill(skill_id: UUID, actor: ActorDep, request: Request, session: SessionDep) -> dict[str, object]:
    return await _set_skill_status(session, actor, request, skill_id, "delisted", admin_required=True)


@router.post("/skills/{skill_id}:publish")
async def publish_skill(skill_id: UUID, actor: ActorDep, request: Request, session: SessionDep) -> dict[str, object]:
    skill = await _load_skill(session, skill_id)
    if skill["latest_published_version_id"] is None:
        raise AppError(ErrorCode.CONFLICT, "没有可发布的版本")
    return await _set_skill_status(session, actor, request, skill_id, "published", admin_required=True)


@router.post("/skills/{skill_id}:disable")
async def disable_skill(
    skill_id: UUID,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    reason: str = Query(default=""),
) -> dict[str, object]:
    if not reason.strip():
        raise AppError(ErrorCode.VALIDATION_FAILED, "停用必须填写原因")
    result = await _set_skill_status(
        session, actor, request, skill_id, "disabled", admin_required=True, reason=reason
    )
    skill = await _load_skill(session, skill_id, include_disabled=True)
    affected = await notify_activation_users(
        session,
        resource_type="skill",
        ref_id=skill_id,
        kind="skill.disabled",
        params={"name": skill["name"], "reason": reason},
        payload={"skillId": str(skill_id), "reason": reason},
    )
    await session.commit()
    return {**result, "notified": affected}


@router.post("/skills/{skill_id}:enable")
async def enable_skill(skill_id: UUID, actor: ActorDep, request: Request, session: SessionDep) -> dict[str, object]:
    return await _set_skill_status(session, actor, request, skill_id, "published", admin_required=True)


@router.delete("/skills/{skill_id}")
async def delete_skill(skill_id: UUID, actor: ActorDep, request: Request, session: SessionDep) -> dict[str, object]:
    async def notify(row: RowMapping) -> int:
        return await notify_activation_users(
            session,
            resource_type="skill",
            ref_id=skill_id,
            kind="skill.deleted",
            params={"name": row["name"]},
            payload={"skillId": str(skill_id)},
        )

    return await delete_resource(session, actor, request, SKILL_SPEC, skill_id, notify)


@router.post("/skills/{skill_id}/versions/{version}:revoke")
async def revoke_version(
    skill_id: UUID,
    version: str,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    reason: str = Query(default=""),
) -> dict[str, object]:
    if not reason.strip():
        raise AppError(ErrorCode.VALIDATION_FAILED, "撤回版本必须填写原因")
    skill = await _load_skill(session, skill_id)
    await require_team_access(session, actor, skill["team_id"], admin=True)
    row = (
        await session.execute(SELECT_VERSION, {"skill_id": skill_id, "version": version})
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "版本不存在")
    await session.execute(
        text("UPDATE skill_versions SET status = 'revoked', revoked_reason = :reason WHERE id = :id"),
        {"id": row["id"], "reason": reason},
    )
    # 若撤回的是最新已发布版本，把 latest 指针回退到可用的上一版（design 6.4.1/6.4.5）
    replacement_row = (
        await session.execute(
            text(
                """
                SELECT id, version FROM skill_versions
                WHERE skill_id = :skill_id AND status IN ('published', 'superseded') AND id <> :id
                ORDER BY created_at DESC LIMIT 1
                """
            ),
            {"skill_id": skill_id, "id": row["id"]},
        )
    ).mappings().first()
    was_latest = (
        await session.execute(
            text("SELECT latest_published_version_id FROM skills WHERE id = :id"),
            {"id": skill_id},
        )
    ).scalar_one()
    if was_latest == row["id"] and replacement_row is not None:
        await session.execute(
            text("UPDATE skills SET latest_published_version_id = :version_id WHERE id = :id"),
            {"id": skill_id, "version_id": replacement_row["id"]},
        )
    await session.execute(
        text("UPDATE skills SET status_revision = nextval('resource_status_revision_seq') WHERE id = :id"),
        {"id": skill_id},
    )
    replacement = replacement_row["version"] if replacement_row is not None else None
    affected = await notify_activation_users(
        session,
        resource_type="skill",
        ref_id=skill_id,
        kind="skill.version_revoked",
        params={"name": skill["name"], "version": version, "reason": reason, "replacement": replacement},
        payload={"skillId": str(skill_id), "version": version, "replacementVersion": replacement, "reason": reason},
    )
    await record_audit(
        session,
        action="skill.revoke_version",
        actor_id=actor.user_id,
        org_id=skill["org_id"],
        target_type="skill_version",
        target_id=str(row["id"]),
        detail={"version": version, "reason": reason, "affectedUsers": affected},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {"id": str(row["id"]), "status": "revoked", "replacementVersion": replacement, "notified": affected}


@router.get("/marketplace/skills", response_model=SkillListOut)
async def marketplace(
    actor: ActorDep,
    session: SessionDep,
    q: str = Query(default=""),
    tag: str = Query(default=""),
    sort: Literal["updated", "name", "downloads"] = Query(default="updated"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> SkillListOut:
    team_ids = await team_ids_for_user(session, actor.user_id)
    if not team_ids:
        return SkillListOut(items=[], total=0)
    rows = (
        await session.execute(
            MARKETPLACE,
            {"team_ids": team_ids, "q": q, "tag": tag, "sort": sort, "limit": limit, "offset": offset},
        )
    ).mappings().all()
    return SkillListOut(items=[_skill_out(row) for row in rows], total=len(rows))


async def _submit_version(
    session: AsyncSession,
    actor: Actor,
    request: Request,
    *,
    team_id: UUID,
    org_id: UUID,
    skill_id: UUID,
    package: ValidatedPackage,
    data: bytes,
    changelog: str,
) -> dict[str, object]:
    front = package.front_matter
    if front is None:
        raise AppError(ErrorCode.INTERNAL, "包校验未生成 front matter")
    version = front.version
    if version is None:
        raise AppError(ErrorCode.VALIDATION_FAILED, "front matter 必须声明 version（semver）")

    pending = (
        await session.execute(
            text("SELECT 1 FROM skill_versions WHERE skill_id = :skill_id AND status = 'pending'"),
            {"skill_id": skill_id},
        )
    ).first()
    if pending is not None:
        raise AppError(ErrorCode.CONFLICT, "该 Skill 已有待审批版本，请先撤回或等待审批")

    duplicate = (
        await session.execute(
            text("SELECT 1 FROM skill_versions WHERE skill_id = :skill_id AND version = :version"),
            {"skill_id": skill_id, "version": version},
        )
    ).first()
    if duplicate is not None:
        raise AppError(ErrorCode.CONFLICT, f"版本 {version} 已存在")

    digest = package.digest
    digest_hex = digest.split(":", 1)[-1]
    object_key = f"skills/{org_id}/{team_id}/{skill_id}/{version}/{digest_hex}.hskill"
    manifest: dict[str, Any] = package_manifest(package)
    manifest["skillMd"] = package.body[:MAX_SKILL_MD_PREVIEW]
    get_object_store().put(object_key, data)

    version_row = (
        await session.execute(
            text(
                """
                INSERT INTO skill_versions (skill_id, version, digest, object_key, size_bytes, file_count,
                                            manifest, changelog, created_by)
                VALUES (:skill_id, :version, :digest, :object_key, :size_bytes, :file_count,
                        CAST(:manifest AS jsonb), :changelog, :created_by)
                RETURNING id, status
                """
            ),
            {
                "skill_id": skill_id,
                "version": version,
                "digest": digest,
                "object_key": object_key,
                "size_bytes": package.size_bytes,
                "file_count": package.file_count,
                "manifest": json.dumps(manifest, ensure_ascii=False),
                "changelog": changelog,
                "created_by": actor.user_id,
            },
        )
    ).mappings().one()

    approval = (
        await session.execute(
            text(
                """
                INSERT INTO approval_requests (type, requester_id, org_id, team_id, target_type, target_id, payload)
                VALUES ('skill_version_publish', :requester_id, :org_id, :team_id, 'skill_version', :target_id,
                        CAST(:payload AS jsonb))
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
                        "skillId": str(skill_id),
                        "version": version,
                        "name": front.name,
                        "digest": digest,
                        "files": package.file_count,
                        "scripts": package.script_files,
                        "requires": manifest["frontMatter"]["requires"],
                    },
                    ensure_ascii=False,
                ),
            },
        )
    ).scalar_one()
    await session.execute(
        text("UPDATE skill_versions SET review_id = :review_id WHERE id = :id"),
        {"review_id": approval, "id": version_row["id"]},
    )
    await notify_team_admins(
        session,
        team_id,
        kind="approval.skill_version_publish",
        params={"name": front.name, "version": version, "actor": actor.display_name},
        payload={"approvalId": str(approval), "skillId": str(skill_id), "version": version},
    )
    await record_audit(
        session,
        action="skill.version.submit",
        actor_id=actor.user_id,
        org_id=org_id,
        target_type="skill_version",
        target_id=str(version_row["id"]),
        detail={"skillId": str(skill_id), "version": version, "digest": digest},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return {
        "skillId": str(skill_id),
        "versionId": str(version_row["id"]),
        "version": version,
        "status": version_row["status"],
        "approvalId": str(approval),
        "digest": digest,
    }


async def _set_skill_status(
    session: AsyncSession,
    actor: Actor,
    request: Request,
    skill_id: UUID,
    status: str,
    *,
    admin_required: bool,
    reason: str | None = None,
) -> dict[str, object]:
    return await set_resource_status(
        session, actor, request, SKILL_SPEC, skill_id, status, admin_required=admin_required, reason=reason
    )


async def _load_skill(
    session: AsyncSession, skill_id: UUID, *, include_disabled: bool = False
) -> RowMapping:
    return await load_resource(session, SKILL_SPEC, {"skill_id": skill_id}, include_disabled=include_disabled)


async def read_body(request: Request) -> bytes:
    max_bytes = get_settings().skill_package_max_bytes
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise AppError(ErrorCode.PACKAGE_INVALID, f"包超过大小上限（{max_bytes // (1024 * 1024)} MB）")
        chunks.append(chunk)
    return b"".join(chunks)


def _validate(data: bytes, settings: Settings) -> ValidatedPackage:
    try:
        return validate_skill_package(
            data,
            max_bytes=settings.skill_package_max_bytes,
            unpack_max_bytes=settings.skill_unpack_max_bytes,
            max_files=settings.skill_max_files,
            max_compression_ratio=settings.skill_max_compression_ratio,
            current_app_version=settings.min_client_version,
        )
    except PackageInvalidError as exc:
        raise AppError(ErrorCode.PACKAGE_INVALID, str(exc)) from exc


def _skill_out(row: Any) -> SkillOut:
    return SkillOut(
        id=row["id"],
        org_id=row["org_id"],
        team_id=row["team_id"],
        name=str(row["name"]),
        description=str(row["description"]),
        tags=list(row["tags"] or []),
        status=str(row["status"]),
        status_revision=int(row["status_revision"]),
        latest_version=row["latest_version"],
        download_count=int(row["download_count"] or 0),
        updated_at=row["updated_at"],
    )

