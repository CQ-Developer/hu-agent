"""系统路由：健康检查与 schema 信息（阶段 0 冒烟用）。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.domain.db import get_session
from huagent.domain.schema import applied_versions

router = APIRouter()

Session = Annotated[AsyncSession, Depends(get_session)]


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
