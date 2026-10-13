"""FastAPI 应用装配。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from huagent.api.errors import install_exception_handlers
from huagent.api.middleware import TraceIdMiddleware
from huagent.api.routes import system
from huagent.common.config import get_settings
from huagent.domain.db import dispose_engine
from huagent.domain.schema import verify_schema


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    if settings.schema_check_enabled:
        await verify_schema(settings.schema_expected_version)
    yield
    await dispose_engine()


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title="hu-agent-management",
        version="0.1.0",
        lifespan=lifespan,
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs" if settings.env == "local" else None,
        redoc_url=None,
    )
    app.add_middleware(TraceIdMiddleware)
    install_exception_handlers(app)
    app.include_router(system.router, prefix="/api/v1/system", tags=["system"])

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
    return app


app = create_app()
