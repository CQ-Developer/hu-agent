"""运行配置：环境变量前缀 HUAGENT_，本地可放 .env。"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="HUAGENT_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: str = "local"
    api_host: str = "127.0.0.1"
    api_port: int = 8080
    cors_origins: list[str] = []

    database_url: str = "postgresql+psycopg://huagent:huagent_dev@localhost:5432/huagent"
    redis_url: str = "redis://localhost:6379/0"

    # 启动时校验数据库 schema 版本（design 6.8.3）；阶段 0 期望 V0001
    schema_check_enabled: bool = True
    schema_expected_version: str = "V0001"

    # 对象存储（阶段 5/6 使用）
    s3_endpoint: str = "http://localhost:9000"
    s3_region: str = "us-east-1"
    s3_access_key: str = "huagent"
    s3_secret_key: str = "huagent_dev_minio"
    s3_bucket_skills: str = "hu-agent-skills"
    s3_bucket_snapshots: str = "hu-agent-snapshots"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
