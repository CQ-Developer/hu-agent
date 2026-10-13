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

    # 认证（design 4.1 / 6.10.1 / 8.1）
    jwt_secret: str = "dev-only-change-me-0123456789abcdef"  # noqa: S105 —— 生产必须由 HUAGENT_JWT_SECRET 覆盖
    jwt_algorithm: str = "HS256"
    access_token_ttl_seconds: int = 900
    refresh_token_ttl_seconds: int = 30 * 24 * 3600
    auth_registration_enabled: bool = True
    login_ip_limit: int = 10
    login_ip_window_seconds: int = 60
    login_fail_threshold: int = 5
    # Redis 不可用时是否拒绝登录（生产建议 true；本地/测试 false 走内存降级）
    rate_limit_strict: bool = False
    # 弱口令名单文件（每行一个；生产可挂载到 top-10k 名单）
    weak_password_file: str = ""

    # 启动时校验数据库 schema 版本（design 6.8.3）；阶段 5 期望 V0002
    schema_check_enabled: bool = True
    schema_expected_version: str = "V0002"

    # 对象存储（阶段 5/6 使用）
    s3_endpoint: str = "http://localhost:9000"
    s3_region: str = "us-east-1"
    s3_access_key: str = "huagent"
    s3_secret_key: str = "huagent_dev_minio"  # noqa: S105 —— 仅本地开发默认值，生产由环境变量覆盖
    s3_bucket_skills: str = "hu-agent-skills"
    s3_bucket_snapshots: str = "hu-agent-snapshots"
    # 对象存储实现：s3（生产）/ memory（测试）
    object_store: str = "s3"
    # 技能包上传限制（design 6.4.2）
    skill_package_max_bytes: int = 20 * 1024 * 1024
    skill_unpack_max_bytes: int = 100 * 1024 * 1024
    skill_max_files: int = 500
    skill_max_compression_ratio: int = 200
    # 最低支持的客户端版本（design 8.3；阶段 6 可由 system_settings 覆盖）
    min_client_version: str = "0.1.0"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
