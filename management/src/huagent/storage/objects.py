"""对象存储抽象（design 6.4.2 / 6.10.2）。

- 生产使用 S3/MinIO（私有桶 + 短时效预签名 URL）
- 测试可用内存实现（HUAGENT_OBJECT_STORE=memory），避免测试强依赖 MinIO
"""

from __future__ import annotations

import contextlib
import hashlib
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
    def presign_put(self, key: str, ttl_seconds: int = 3600, content_type: str = "application/zip") -> str: ...
    def size(self, key: str) -> int | None: ...
    def digest(self, key: str) -> tuple[str, int]: ...


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
            with contextlib.suppress(Exception):
                client.create_bucket(Bucket=self._bucket)
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

    def presign_put(self, key: str, ttl_seconds: int = 3600, content_type: str = "application/zip") -> str:
        self._ensure_bucket()
        url: str = get_s3_client().generate_presigned_url(
            "put_object",
            Params={"Bucket": self._bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=ttl_seconds,
        )
        return url

    def size(self, key: str) -> int | None:
        try:
            response: Any = get_s3_client().head_object(Bucket=self._bucket, Key=key)
            return int(response["ContentLength"])
        except Exception:  # noqa: BLE001 —— 不存在或权限错误均视为未知
            return None

    def digest(self, key: str) -> tuple[str, int]:
        """流式计算对象 sha256，避免一次性载入内存。"""
        hasher = hashlib.sha256()
        size = 0
        body: Any = get_s3_client().get_object(Bucket=self._bucket, Key=key)["Body"]
        while True:
            chunk = body.read(1024 * 1024)
            if not chunk:
                break
            hasher.update(chunk)
            size += len(chunk)
        return f"sha256:{hasher.hexdigest()}", size


class MemoryObjectStore:
    """测试用：进程内字典，预签名返回固定前缀 URL。"""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.puts: dict[str, str] = {}

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

    def presign_put(self, key: str, ttl_seconds: int = 3600, content_type: str = "application/zip") -> str:
        self.puts[key] = content_type
        return f"memory-put://{key}?ttl={ttl_seconds}"

    def size(self, key: str) -> int | None:
        return len(self.objects[key]) if key in self.objects else None

    def digest(self, key: str) -> tuple[str, int]:
        data = self.get(key)
        return f"sha256:{hashlib.sha256(data).hexdigest()}", len(data)


_memory_stores: dict[str, MemoryObjectStore] = {}
_s3_stores: dict[str, S3ObjectStore] = {}

# 用途 → 配置项（分桶放置：快照与技能包的生命周期/权限策略不同）
_BUCKET_SETTINGS: dict[str, str] = {
    "skills": "s3_bucket_skills",
    "snapshots": "s3_bucket_snapshots",
}


def get_object_store(purpose: str = "skills") -> ObjectStore:
    """按用途取对象存储（每个桶一个实例，内存实现也同样隔离）。"""
    settings = get_settings()
    attribute = _BUCKET_SETTINGS.get(purpose)
    if attribute is None:
        raise ValueError(f"未知存储用途：{purpose}（可选 {sorted(_BUCKET_SETTINGS)}）")
    bucket = getattr(settings, attribute)
    if settings.object_store == "memory":
        if bucket not in _memory_stores:
            _memory_stores[bucket] = MemoryObjectStore()
        return _memory_stores[bucket]
    if bucket not in _s3_stores:
        _s3_stores[bucket] = S3ObjectStore(bucket)
    return _s3_stores[bucket]
