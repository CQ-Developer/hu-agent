"""对象存储抽象（design 6.4.2 / 6.10.2）。

- 生产使用 S3/MinIO（私有桶 + 短时效预签名 URL）
- 测试可用内存实现（HUAGENT_OBJECT_STORE=memory），避免测试强依赖 MinIO
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from huagent.common.config import get_settings
from huagent.storage.s3 import get_s3_client


@dataclass(frozen=True)
class PresignedUrl:
    url: str
    expiresIn: int


class ObjectStore(Protocol):
    def put(self, key: str, data: bytes, content_type: str = "application/zip") -> None: ...
    def get(self, key: str) -> bytes: ...
    def exists(self, key: str) -> bool: ...
    def delete(self, key: str) -> None: ...
    def presign_get(self, key: str, ttl_seconds: int = 300) -> str: ...


class S3ObjectStore:
    def __init__(self, bucket: str) -> None:
        self._bucket = bucket
        self._bucket_ready = False

    def _ensure_bucket(self) -> None:
        """首次写入前确保桶存在（本地 MinIO 零配置；生产通常已预建，幂等）。"""
        if self._bucket_ready:
            return
        client = get_s3_client()
        try:
            client.head_bucket(Bucket=self._bucket)
        except Exception:  # noqa: BLE001 —— 不存在或无权限时尝试创建
            try:
                client.create_bucket(Bucket=self._bucket)
            except Exception:  # noqa: BLE001 —— 并发创建/已存在则忽略
                pass
        self._bucket_ready = True

    def put(self, key: str, data: bytes, content_type: str = "application/zip") -> None:
        self._ensure_bucket()
        get_s3_client().put_object(Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)

    def get(self, key: str) -> bytes:
        response: Any = get_s3_client().get_object(Bucket=self._bucket, Key=key)
        return bytes(response["Body"].read())

    def exists(self, key: str) -> bool:
        try:
            get_s3_client().head_object(Bucket=self._bucket, Key=key)
            return True
        except Exception:  # noqa: BLE001 —— 任何 NotFound/权限错误都视为不存在
            return False

    def delete(self, key: str) -> None:
        get_s3_client().delete_object(Bucket=self._bucket, Key=key)

    def presign_get(self, key: str, ttl_seconds: int = 300) -> str:
        url: str = get_s3_client().generate_presigned_url(
            "get_object",
            Params={"Bucket": self._bucket, "Key": key},
            ExpiresIn=ttl_seconds,
        )
        return url


class MemoryObjectStore:
    """测试用：进程内字典，预签名返回固定前缀 URL。"""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    def put(self, key: str, data: bytes, content_type: str = "application/zip") -> None:
        self.objects[key] = data

    def get(self, key: str) -> bytes:
        if key not in self.objects:
            raise KeyError(key)
        return self.objects[key]

    def exists(self, key: str) -> bool:
        return key in self.objects

    def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    def presign_get(self, key: str, ttl_seconds: int = 300) -> str:
        return f"memory://{key}?ttl={ttl_seconds}"


_memory_store: MemoryObjectStore | None = None


def get_object_store() -> ObjectStore:
    settings = get_settings()
    if settings.object_store == "memory":
        global _memory_store
        if _memory_store is None:
            _memory_store = MemoryObjectStore()
        return _memory_store
    return S3ObjectStore(settings.s3_bucket_skills)
