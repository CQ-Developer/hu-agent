"""S3/MinIO 客户端与预签名。

阶段 5/6 在此补充：上传/下载预签名、流式 sha256 校验、对象存在性检查。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import boto3
from botocore.client import Config as BotoConfig

from huagent.common.config import get_settings


@lru_cache(maxsize=1)
def get_s3_client() -> Any:
    settings = get_settings()
    return boto3.client(
        "s3",
        endpoint_url=settings.s3_endpoint,
        region_name=settings.s3_region,
        aws_access_key_id=settings.s3_access_key,
        aws_secret_access_key=settings.s3_secret_key,
        config=BotoConfig(signature_version="s3v4"),
    )
