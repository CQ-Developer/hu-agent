"""通用审批流（design 6.3.1 / 6.9.2）：四种类型共用一张表 + 按类型校验与生效。

状态机单调：pending → approved / rejected / cancelled（唯一部分索引保证同一 target 只有一个 pending）。
"""

from __future__ import annotations

import json
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import text
from sqlalchemy.engine import RowMapping
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.notifications import notify
from huagent.domain.rbac import get_org_access, get_team_access, require_org_access, require_team_access

router = APIRouter(tags=["approvals"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]

ApprovalType = Literal["org_create", "team_create", "skill_version_publish", "mcp_version_publish"]
ApprovalStatus = Literal["pending", "approved", "rejected", "cancelled", "stale"]


class ApprovalOut(ApiModel):
    id: UUID
    type: str
    requester_id: UUID
    org_id: UUID | None
    team_id: UUID | None
    target_type: str | None
    target_id: str | None
    payload: dict[str, object]
    status: str
    reviewer_id: UUID | None
    review_comment: str | None
    created_at: datetime
    decided_at: datetime | None


class ApprovalListOut(ApiModel):
    items: list[ApprovalOut]
    total: int


class DecisionIn(ApiModel):
    comment: str = ""


SELECT_APPROVAL = text(
    """
    SELECT id, type, requester_id, org_id, team_id, target_type, target_id, payload, status,
           reviewer_id, review_comment, created_at, decided_at
    FROM approval_requests WHERE id = :id
    """
)

LIST_BASE = """
    SELECT id, type, requester_id, org_id, team_id, target_type, target_id, payload, status,
           reviewer_id, review_comment, created_at, decided_at
    FROM approval_requests
    WHERE TRUE
"""


@router.get("/approvals", response_model=ApprovalListOut)
async def list_approvals(
    actor: ActorDep,
    session: SessionDep,
    scope: Annotated[Literal["system", "org", "team", "mine"], Query()] = "mine",
    org_id: Annotated[UUID | None, Query()] = None,
    team_id: Annotated[UUID | None, Query()] = None,
    status: Annotated[ApprovalStatus | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ApprovalListOut:
    conditions: list[str] = []
    params: dict[str, object] = {"limit": limit, "offset": offset}

    if scope == "mine":
        conditions.append("requester_id = :actor_id")
        params["actor_id"] = actor.user_id
    elif scope == "system":
        if not actor.is_system_admin:
            raise AppError(ErrorCode.FORBIDDEN, "需要系统管理员权限")
        conditions.append("type = 'org_create'")
    elif scope == "org":
        if org_id is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=org 需要 orgId")
        await require_org_access(session, actor, org_id, admin=True)
        conditions.append("org_id = :org_id")
        params["org_id"] = org_id
    else:  # team
        if team_id is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, "scope=team 需要 teamId")
        await require_team_access(session, actor, team_id, admin=True)
        conditions.append("team_id = :team_id")
        params["team_id"] = team_id

    if status is not None:
        conditions.append("status = :status")
        params["status"] = status

    where = " AND ".join(conditions) if conditions else "TRUE"
    rows = (
        await session.execute(
            text(f"{LIST_BASE} AND {where} ORDER BY created_at DESC LIMIT :limit OFFSET :offset"),
            params,
        )
    ).mappings().all()
    total = int(
        (
            await session.execute(
                text(f"SELECT count(*) FROM approval_requests WHERE {where}"),  # noqa: S608 —— where 为静态片段，值全为绑定参数
                {key: value for key, value in params.items() if key not in {"limit", "offset"}},
            )
        ).scalar_one()
    )
    return ApprovalListOut(items=[_to_out(row) for row in rows], total=total)


@router.get("/approvals/{approval_id}", response_model=ApprovalOut)
async def get_approval(approval_id: UUID, actor: ActorDep, session: SessionDep) -> ApprovalOut:
    row = (await session.execute(SELECT_APPROVAL, {"id": approval_id})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "审批不存在")
    await _authorize_view(session, actor, row)
    return _to_out(row)


@router.post("/approvals/{approval_id}:approve", response_model=ApprovalOut)
async def approve(
    approval_id: UUID,
    payload: DecisionIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> ApprovalOut:
    row = await _lock_pending(session, approval_id)
    await _authorize_decide(session, actor, row)
    await _apply_effect(session, row, actor)
    updated = await _decide(session, approval_id, actor, "approved", payload.comment)
    await notify(
        session,
        [row["requester_id"]],
        type="approval.approved",
        title="审批已通过",
        body=payload.comment or "你的申请已通过。",
        payload={"approvalId": str(approval_id), "type": row["type"]},
    )
    await record_audit(
        session,
        action=f"approval.approve.{row['type']}",
        actor_id=actor.user_id,
        org_id=row["org_id"],
        target_type="approval",
        target_id=str(approval_id),
        actor_ip=client_ip(request),
    )
    await session.commit()
    return _to_out(updated)


@router.post("/approvals/{approval_id}:reject", response_model=ApprovalOut)
async def reject(
    approval_id: UUID,
    payload: DecisionIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> ApprovalOut:
    comment = payload.comment.strip()
    if not comment:
        raise AppError(ErrorCode.VALIDATION_FAILED, "驳回必须填写意见")
    row = await _lock_pending(session, approval_id)
    await _authorize_decide(session, actor, row)
    # 技能版本驳回后回到可修改状态（design 6.4.1）
    if row["type"] == "skill_version_publish" and row["target_id"]:
        await session.execute(
            text("UPDATE skill_versions SET status = 'rejected' WHERE id = :id AND status = 'pending'"),
            {"id": row["target_id"]},
        )
    updated = await _decide(session, approval_id, actor, "rejected", comment)
    await notify(
        session,
        [row["requester_id"]],
        type="approval.rejected",
        title="审批被驳回",
        body=comment,
        payload={"approvalId": str(approval_id), "type": row["type"]},
    )
    await record_audit(
        session,
        action=f"approval.reject.{row['type']}",
        actor_id=actor.user_id,
        org_id=row["org_id"],
        target_type="approval",
        target_id=str(approval_id),
        detail={"comment": comment},
        actor_ip=client_ip(request),
    )
    await session.commit()
    return _to_out(updated)


@router.post("/approvals/{approval_id}:cancel", response_model=ApprovalOut)
async def cancel(approval_id: UUID, actor: ActorDep, session: SessionDep) -> ApprovalOut:
    row = await _lock_pending(session, approval_id)
    if row["requester_id"] != actor.user_id:
        raise AppError(ErrorCode.FORBIDDEN, "只有申请人可以撤回")
    if row["type"] == "skill_version_publish" and row["target_id"]:
        await session.execute(
            text("UPDATE skill_versions SET status = 'rejected' WHERE id = :id AND status = 'pending'"),
            {"id": row["target_id"]},
        )
    updated = await _decide(session, approval_id, actor, "cancelled", "申请人撤回")
    await session.commit()
    return _to_out(updated)


async def _lock_pending(session: AsyncSession, approval_id: UUID) -> RowMapping:
    row = (
        await session.execute(
            text(f"{LIST_BASE} AND id = :id FOR UPDATE"), {"id": approval_id}
        )
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "审批不存在")
    if row["status"] != "pending":
        raise AppError(ErrorCode.CONFLICT, "该审批已处理")
    return row


async def _authorize_decide(session: AsyncSession, actor: Actor, row: RowMapping) -> None:
    if row["type"] == "org_create":
        if not actor.is_system_admin:
            raise AppError(ErrorCode.FORBIDDEN, "需要系统管理员审批")
        return
    if row["type"] == "team_create":
        if row["org_id"] is None:
            raise AppError(ErrorCode.INTERNAL, "审批归属缺失")
        await require_org_access(session, actor, row["org_id"], admin=True)
        return
    if row["team_id"] is not None:
        await require_team_access(session, actor, row["team_id"], admin=True)
        return
    raise AppError(ErrorCode.INTERNAL, "审批归属缺失")


async def _authorize_view(session: AsyncSession, actor: Actor, row: RowMapping) -> None:
    if row["requester_id"] == actor.user_id or actor.is_system_admin:
        return
    if row["org_id"] is not None:
        access = await get_org_access(session, actor.user_id, row["org_id"])
        if access is not None and access.is_admin:
            return
    if row["team_id"] is not None:
        team_access = await get_team_access(session, actor.user_id, row["team_id"])
        if team_access is not None and team_access.is_admin:
            return
    raise AppError(ErrorCode.FORBIDDEN, "无权查看该审批")


async def _decide(
    session: AsyncSession,
    approval_id: UUID,
    actor: Actor,
    decision: Literal["approved", "rejected", "cancelled"],
    comment: str,
) -> RowMapping:
    row = (
        await session.execute(
            text(
                """
                UPDATE approval_requests
                SET status = :status, reviewer_id = :reviewer_id, review_comment = :comment, decided_at = now()
                WHERE id = :id AND status = 'pending'
                RETURNING id, type, requester_id, org_id, team_id, target_type, target_id, payload, status,
                          reviewer_id, review_comment, created_at, decided_at
                """
            ),
            {
                "id": approval_id,
                "status": decision,
                "reviewer_id": actor.user_id if decision != "cancelled" else None,
                "comment": comment,
            },
        )
    ).mappings().first()
    if row is None:
        raise AppError(ErrorCode.CONFLICT, "该审批已处理")
    return row


async def _apply_effect(session: AsyncSession, row: RowMapping, actor: Actor) -> None:
    """审批通过后的业务生效（design 6.3.2/6.3.3/6.4.1）。"""
    payload = row["payload"] or {}
    if row["type"] == "org_create":
        await _effect_org_create(session, payload, row["requester_id"])
        return
    if row["type"] == "team_create":
        await _effect_team_create(session, payload, row["requester_id"], row["org_id"])
        return
    if row["type"] == "skill_version_publish":
        await _effect_skill_publish(session, row["target_id"])
        return
    raise AppError(ErrorCode.VALIDATION_FAILED, f"暂不支持审批类型：{row['type']}")


async def _effect_org_create(session: AsyncSession, payload: dict[str, object], requester_id: UUID) -> None:
    slug = str(payload.get("slug") or "")
    name = str(payload.get("name") or slug)
    duplicate = (
        await session.execute(text("SELECT 1 FROM orgs WHERE slug = :slug AND status <> 'deleted'"), {"slug": slug})
    ).first()
    if duplicate is not None:
        raise AppError(ErrorCode.NAME_CONFLICT, "slug 已被占用，审批失败")
    org_id = (
        await session.execute(
            text(
                """
                INSERT INTO orgs (name, slug, description, created_by)
                VALUES (:name, :slug, :description, :created_by) RETURNING id
                """
            ),
            {"name": name, "slug": slug, "description": payload.get("description", ""), "created_by": requester_id},
        )
    ).scalar_one()
    await session.execute(
        text("INSERT INTO org_members (org_id, user_id, role) VALUES (:org_id, :user_id, 'admin')"),
        {"org_id": org_id, "user_id": requester_id},
    )


async def _effect_team_create(
    session: AsyncSession,
    payload: dict[str, object],
    requester_id: UUID,
    org_id: UUID | None,
) -> None:
    if org_id is None:
        raise AppError(ErrorCode.INTERNAL, "审批缺少组织归属")
    name = str(payload.get("name") or "")
    duplicate = (
        await session.execute(
            text("SELECT 1 FROM teams WHERE org_id = :org_id AND name = :name AND status <> 'deleted'"),
            {"org_id": org_id, "name": name},
        )
    ).first()
    if duplicate is not None:
        raise AppError(ErrorCode.NAME_CONFLICT, "团队名已被占用，审批失败")
    team_id = (
        await session.execute(
            text(
                """
                INSERT INTO teams (org_id, name, description, created_by)
                VALUES (:org_id, :name, :description, :created_by) RETURNING id
                """
            ),
            {"org_id": org_id, "name": name, "description": payload.get("description", ""), "created_by": requester_id},
        )
    ).scalar_one()
    await session.execute(
        text("INSERT INTO team_members (team_id, user_id, role) VALUES (:team_id, :user_id, 'admin')"),
        {"team_id": team_id, "user_id": requester_id},
    )


async def _effect_skill_publish(session: AsyncSession, target_id: str | None) -> None:
    if not target_id:
        raise AppError(ErrorCode.INTERNAL, "审批缺少版本目标")
    version_row = (
        await session.execute(
            text("SELECT id, skill_id, version FROM skill_versions WHERE id = :id FOR UPDATE"),
            {"id": target_id},
        )
    ).mappings().first()
    if version_row is None:
        raise AppError(ErrorCode.NOT_FOUND, "版本不存在")
    skill = (
        await session.execute(
            text("SELECT id, status FROM skills WHERE id = :id FOR UPDATE"),
            {"id": version_row["skill_id"]},
        )
    ).mappings().one()
    if skill["status"] == "disabled":
        raise AppError(ErrorCode.CONFLICT, "资源已停用，无法发布新版本")

    # 旧版本标记 superseded（仍可下载固定版本）
    await session.execute(
        text(
            "UPDATE skill_versions SET status = 'superseded' WHERE skill_id = :skill_id "
            "AND status = 'published' AND id <> :id"
        ),
        {"skill_id": skill["id"], "id": version_row["id"]},
    )
    await session.execute(
        text("UPDATE skill_versions SET status = 'published' WHERE id = :id"),
        {"id": version_row["id"]},
    )
    next_status = "published" if skill["status"] in {"draft", "published"} else skill["status"]
    await session.execute(
        text(
            "UPDATE skills SET status = :status, latest_published_version_id = :version_id, "
            "status_revision = nextval('resource_status_revision_seq') WHERE id = :id"
        ),
        {"id": skill["id"], "version_id": version_row["id"], "status": next_status},
    )


def _to_out(row: RowMapping) -> ApprovalOut:
    payload = row["payload"]
    if isinstance(payload, str):
        payload = json.loads(payload)
    return ApprovalOut(
        id=row["id"],
        type=str(row["type"]),
        requester_id=row["requester_id"],
        org_id=row["org_id"],
        team_id=row["team_id"],
        target_type=row["target_type"],
        target_id=row["target_id"],
        payload=payload or {},
        status=str(row["status"]),
        reviewer_id=row["reviewer_id"],
        review_comment=row["review_comment"],
        created_at=row["created_at"],
        decided_at=row["decided_at"],
    )
