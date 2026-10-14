"""运维管理接口（design 7.2 系统区）：审计日志、系统设置、价格表。

仅系统管理员可访问；所有写操作写审计（admin.*）。
设置项采用**白名单**：只有被代码消费的键可读写，避免 system_settings 变成任意键值仓库。
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.api.deps import Actor, client_ip, get_actor
from huagent.api.schemas import ApiModel
from huagent.common.config import get_settings
from huagent.common.errors import AppError, ErrorCode
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session
from huagent.domain.settings import set_setting

router = APIRouter(prefix="/admin", tags=["admin"])

SessionDep = Annotated[AsyncSession, Depends(get_session)]
ActorDep = Annotated[Actor, Depends(get_actor)]


def _require_system_admin(actor: Actor) -> None:
    if not actor.is_system_admin:
        raise AppError(ErrorCode.FORBIDDEN, "需要系统管理员权限")


# ---------------------------------------------------------------- 审计日志

class AuditOut(ApiModel):
    id: int
    org_id: UUID | None
    actor_id: UUID | None
    action: str
    target_type: str | None
    target_id: str | None
    detail: dict[str, Any]
    created_at: datetime


class AuditListOut(ApiModel):
    items: list[AuditOut]
    total: int


SELECT_AUDIT = text(
    """
    SELECT id, org_id, actor_id, action, target_type, target_id, detail, created_at
    FROM audit_logs
    WHERE (:action = '' OR action LIKE :action_prefix)
      AND (CAST(:actor_id AS uuid) IS NULL OR actor_id = CAST(:actor_id AS uuid))
      AND (CAST(:org_id AS uuid) IS NULL OR org_id = CAST(:org_id AS uuid))
      AND (CAST(:target_type AS text) IS NULL OR target_type = CAST(:target_type AS text))
      AND (CAST(:date_from AS timestamptz) IS NULL OR created_at >= CAST(:date_from AS timestamptz))
      AND (CAST(:date_to AS timestamptz) IS NULL OR created_at < CAST(:date_to AS timestamptz))
    ORDER BY id DESC
    LIMIT :limit OFFSET :offset
    """
)
COUNT_AUDIT = text(
    """
    SELECT count(*) FROM audit_logs
    WHERE (:action = '' OR action LIKE :action_prefix)
      AND (CAST(:actor_id AS uuid) IS NULL OR actor_id = CAST(:actor_id AS uuid))
      AND (CAST(:org_id AS uuid) IS NULL OR org_id = CAST(:org_id AS uuid))
      AND (CAST(:target_type AS text) IS NULL OR target_type = CAST(:target_type AS text))
      AND (CAST(:date_from AS timestamptz) IS NULL OR created_at >= CAST(:date_from AS timestamptz))
      AND (CAST(:date_to AS timestamptz) IS NULL OR created_at < CAST(:date_to AS timestamptz))
    """
)


@router.get("/audit", response_model=AuditListOut)
async def list_audit(
    actor: ActorDep,
    session: SessionDep,
    action: str = Query(default="", description="前缀匹配，如 auth. / admin."),
    actor_id: Annotated[UUID | None, Query()] = None,
    org_id: Annotated[UUID | None, Query()] = None,
    target_type: Annotated[str | None, Query()] = None,
    date_from: Annotated[datetime | None, Query()] = None,
    date_to: Annotated[datetime | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AuditListOut:
    _require_system_admin(actor)
    params: dict[str, Any] = {
        "action": action,
        "action_prefix": f"{action}%" if action else "%",
        "actor_id": actor_id,
        "org_id": org_id,
        "target_type": target_type,
        "date_from": date_from,
        "date_to": date_to,
        "limit": limit,
        "offset": offset,
    }
    rows = (await session.execute(SELECT_AUDIT, params)).mappings().all()
    total = int((await session.execute(COUNT_AUDIT, params)).scalar_one())
    return AuditListOut(items=[AuditOut(**dict(row)) for row in rows], total=total)


# ---------------------------------------------------------------- 系统设置

class SettingOut(ApiModel):
    key: str
    value: Any
    value_type: Literal["int", "str"]
    min_value: int | None = None
    default: Any = None
    updated_at: datetime | None = None


class SettingsOut(ApiModel):
    items: list[SettingOut]


class SettingsPatchIn(ApiModel):
    values: dict[str, int | str]


#: 可读写设置（键 → 默认值 / 类型 / 下限）。只有被代码消费的键才能出现在这里。
SETTING_SPECS: dict[str, dict[str, Any]] = {
    "quota.user_bytes": {"default": 10 * 1024**3, "type": "int", "min": 0},
    "quota.team_bytes": {"default": 100 * 1024**3, "type": "int", "min": 0},
    "snapshot.retention": {"default": 20, "type": "int", "min": 1},
    "usage.retention_days": {"default": 90, "type": "int", "min": 7},
    "usage.daily_retention_days": {"default": 730, "type": "int", "min": 30},
    "account.deletion_grace_days": {"default": 30, "type": "int", "min": 0},
    "min_client_version": {"default": "0.1.0", "type": "str"},
}

SELECT_SETTINGS = text("SELECT key, value, updated_at FROM system_settings WHERE key = ANY(:keys)")


@router.get("/settings", response_model=SettingsOut)
async def list_settings(actor: ActorDep, session: SessionDep) -> SettingsOut:
    _require_system_admin(actor)
    rows = (
        await session.execute(SELECT_SETTINGS, {"keys": list(SETTING_SPECS)})
    ).mappings().all()
    stored = {row["key"]: row for row in rows}
    items: list[SettingOut] = []
    for key, spec in SETTING_SPECS.items():
        row = stored.get(key)
        items.append(
            SettingOut(
                key=key,
                value=row["value"] if row else spec["default"],
                value_type=spec["type"],
                min_value=spec.get("min"),
                default=spec["default"],
                updated_at=row["updated_at"] if row else None,
            )
        )
    return SettingsOut(items=items)


@router.patch("/settings", response_model=SettingsOut)
async def update_settings(
    payload: SettingsPatchIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> SettingsOut:
    _require_system_admin(actor)
    if not payload.values:
        raise AppError(ErrorCode.VALIDATION_FAILED, "至少提供一项设置")

    for key, value in payload.values.items():
        spec = SETTING_SPECS.get(key)
        if spec is None:
            raise AppError(ErrorCode.VALIDATION_FAILED, f"不支持的设置项：{key}")
        if spec["type"] == "int":
            if not isinstance(value, int) or isinstance(value, bool):
                raise AppError(ErrorCode.VALIDATION_FAILED, f"{key} 需要整数")
            minimum = spec.get("min")
            if minimum is not None and value < int(minimum):
                raise AppError(ErrorCode.VALIDATION_FAILED, f"{key} 不能小于 {minimum}")
        elif not isinstance(value, str) or not value.strip():
            raise AppError(ErrorCode.VALIDATION_FAILED, f"{key} 需要非空字符串")

    for key, value in payload.values.items():
        await set_setting(session, key, value, updated_by=actor.user_id)
        # min_client_version 同时写入进程内配置：skills.py 的版本校验直接读它（避免每次请求查库）
        if key == "min_client_version":
            get_settings().min_client_version = str(value)

    await record_audit(
        session,
        action="admin.settings.update",
        actor_id=actor.user_id,
        actor_ip=client_ip(request),
        detail={"keys": sorted(payload.values.keys()), "values": payload.values},
    )
    await session.commit()
    return await list_settings(actor, session)


# ---------------------------------------------------------------- 价格表

class PriceOut(ApiModel):
    """模型单价（每 1K token，USD/其它币种按 currency）。"""

    provider: str
    model: str
    currency: str
    input_price: float = Field(description="输入单价 / 1K token")
    output_price: float = Field(description="输出单价 / 1K token")
    cache_read_price: float = Field(description="缓存读单价 / 1K token")
    cache_write_price: float = Field(description="缓存写单价 / 1K token")
    effective_from: date


class PriceIn(ApiModel):
    provider: str
    model: str
    currency: str = "USD"
    input_price: float = 0
    output_price: float = 0
    cache_read_price: float = 0
    cache_write_price: float = 0
    effective_from: date


SELECT_PRICES = text(
    """
    SELECT provider, model, currency,
           input_per_1k::float8 AS input_price, output_per_1k::float8 AS output_price,
           cache_read_per_1k::float8 AS cache_read_price, cache_write_per_1k::float8 AS cache_write_price,
           effective_from
    FROM model_prices
    WHERE (:provider = '' OR provider = :provider) AND (:model = '' OR model = :model)
    ORDER BY provider, model, effective_from DESC
    LIMIT 500
    """
)
UPSERT_PRICE = text(
    """
    INSERT INTO model_prices (provider, model, currency, input_per_1k, output_per_1k,
                              cache_read_per_1k, cache_write_per_1k, effective_from)
    VALUES (:provider, :model, :currency, :input_per_1k, :output_per_1k,
            :cache_read_per_1k, :cache_write_per_1k, :effective_from)
    ON CONFLICT (provider, model, effective_from) DO UPDATE
    SET currency = EXCLUDED.currency,
        input_per_1k = EXCLUDED.input_per_1k,
        output_per_1k = EXCLUDED.output_per_1k,
        cache_read_per_1k = EXCLUDED.cache_read_per_1k,
        cache_write_per_1k = EXCLUDED.cache_write_per_1k
    """
)
DELETE_PRICE = text(
    "DELETE FROM model_prices WHERE provider = :provider AND model = :model AND effective_from = :effective_from"
)


@router.get("/prices", response_model=list[PriceOut])
async def list_prices(
    actor: ActorDep,
    session: SessionDep,
    provider: str = Query(default=""),
    model: str = Query(default=""),
) -> list[PriceOut]:
    _require_system_admin(actor)
    rows = (await session.execute(SELECT_PRICES, {"provider": provider, "model": model})).mappings().all()
    return [PriceOut(**dict(row)) for row in rows]


@router.post("/prices", response_model=PriceOut)
async def upsert_price(
    payload: PriceIn,
    actor: ActorDep,
    request: Request,
    session: SessionDep,
) -> PriceOut:
    _require_system_admin(actor)
    if not payload.provider.strip() or not payload.model.strip():
        raise AppError(ErrorCode.VALIDATION_FAILED, "provider 与 model 不能为空")
    prices = (payload.input_price, payload.output_price, payload.cache_read_price, payload.cache_write_price)
    if min(prices) < 0:
        raise AppError(ErrorCode.VALIDATION_FAILED, "价格不能为负数")

    await session.execute(
        UPSERT_PRICE,
        {
            "provider": payload.provider.strip(),
            "model": payload.model.strip(),
            "currency": payload.currency.strip() or "USD",
            "input_per_1k": payload.input_price,
            "output_per_1k": payload.output_price,
            "cache_read_per_1k": payload.cache_read_price,
            "cache_write_per_1k": payload.cache_write_price,
            "effective_from": payload.effective_from,
        },
    )
    await record_audit(
        session,
        action="admin.price.upsert",
        actor_id=actor.user_id,
        actor_ip=client_ip(request),
        target_type="model_price",
        target_id=f"{payload.provider}/{payload.model}@{payload.effective_from}",
        detail=payload.model_dump(mode="json"),
    )
    await session.commit()
    return PriceOut(**payload.model_dump())


@router.delete("/prices")
async def delete_price(
    actor: ActorDep,
    request: Request,
    session: SessionDep,
    provider: Annotated[str, Query(min_length=1)],
    model: Annotated[str, Query(min_length=1)],
    effective_from: Annotated[date, Query()],
) -> dict[str, int]:
    _require_system_admin(actor)
    result = await session.execute(
        DELETE_PRICE, {"provider": provider, "model": model, "effective_from": effective_from}
    )
    deleted = int(getattr(result, "rowcount", 0) or 0)
    if deleted == 0:
        raise AppError(ErrorCode.NOT_FOUND, "价格记录不存在")
    await record_audit(
        session,
        action="admin.price.delete",
        actor_id=actor.user_id,
        actor_ip=client_ip(request),
        target_type="model_price",
        target_id=f"{provider}/{model}@{effective_from}",
    )
    await session.commit()
    return {"deleted": deleted}


# ---------------------------------------------------------------- 组织治理

FREEZE_ORG = text(
    "UPDATE orgs SET status = :status, updated_at = now() WHERE id = :org_id RETURNING id, name, status"
)
ARCHIVE_ORG_TEAMS = text(
    "UPDATE teams SET status = 'archived', updated_at = now() "
    "WHERE org_id = :org_id AND status = 'active'"
)
DELETE_ORG_SKILLS = text(
    "UPDATE skills SET status = 'deleted', updated_at = now() WHERE org_id = :org_id AND status <> 'deleted'"
)
SELECT_ORG = text("SELECT id, name, slug, description, status FROM orgs WHERE id = :org_id")


class OrgAdminOut(ApiModel):
    id: UUID
    name: str
    slug: str
    description: str
    status: str


async def _set_org_status(
    session: AsyncSession,
    actor: Actor,
    request: Request,
    org_id: UUID,
    status: str,
    action: str,
) -> OrgAdminOut:
    _require_system_admin(actor)
    row = (await session.execute(FREEZE_ORG, {"org_id": org_id, "status": status})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "组织不存在")
    await record_audit(
        session,
        action=action,
        actor_id=actor.user_id,
        actor_ip=client_ip(request),
        org_id=org_id,
        target_type="org",
        target_id=str(org_id),
        detail={"status": status},
    )
    await session.commit()
    full = (await session.execute(SELECT_ORG, {"org_id": org_id})).mappings().one()
    return OrgAdminOut(**dict(full))


@router.post("/orgs/{org_id}:freeze", response_model=OrgAdminOut)
async def freeze_org(org_id: UUID, actor: ActorDep, request: Request, session: SessionDep) -> OrgAdminOut:
    """冻结组织：组织内资源变为只读（design 6.2.1）。系统管理员操作。"""
    return await _set_org_status(session, actor, request, org_id, "frozen", "admin.org.freeze")


@router.post("/orgs/{org_id}:unfreeze", response_model=OrgAdminOut)
async def unfreeze_org(org_id: UUID, actor: ActorDep, request: Request, session: SessionDep) -> OrgAdminOut:
    return await _set_org_status(session, actor, request, org_id, "active", "admin.org.unfreeze")


@router.post("/orgs/{org_id}:dissolve", response_model=OrgAdminOut)
async def dissolve_org(org_id: UUID, actor: ActorDep, request: Request, session: SessionDep) -> OrgAdminOut:
    """解散组织（design 6.10.5）：资源软删、团队归档；个人工作空间与快照不受影响（D12 个人所有）。"""
    _require_system_admin(actor)
    row = (await session.execute(FREEZE_ORG, {"org_id": org_id, "status": "deleted"})).mappings().first()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "组织不存在")
    archived = await session.execute(ARCHIVE_ORG_TEAMS, {"org_id": org_id})
    deleted = await session.execute(DELETE_ORG_SKILLS, {"org_id": org_id})
    await record_audit(
        session,
        action="admin.org.dissolve",
        actor_id=actor.user_id,
        actor_ip=client_ip(request),
        org_id=org_id,
        target_type="org",
        target_id=str(org_id),
        detail={
            "archivedTeams": int(getattr(archived, "rowcount", 0) or 0),
            "deletedSkills": int(getattr(deleted, "rowcount", 0) or 0),
        },
    )
    await session.commit()
    full = (await session.execute(SELECT_ORG, {"org_id": org_id})).mappings().one()
    return OrgAdminOut(**dict(full))
