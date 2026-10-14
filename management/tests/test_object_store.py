"""对象存储分桶访问器测试（快照与技能包必须物理隔离）。"""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from huagent.common.config import get_settings


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("HUAGENT_OBJECT_STORE", "memory")
    monkeypatch.setenv("HUAGENT_S3_BUCKET_SKILLS", "bucket-skills")
    monkeypatch.setenv("HUAGENT_S3_BUCKET_SNAPSHOTS", "bucket-snapshots")
    get_settings.cache_clear()

    from huagent.storage.objects import _memory_stores

    _memory_stores.clear()
    yield
    _memory_stores.clear()
    get_settings.cache_clear()


def test_purpose_maps_to_separate_buckets() -> None:
    from huagent.storage.objects import _memory_stores, get_object_store

    skills = get_object_store()
    snapshots = get_object_store("snapshots")

    assert skills is not snapshots, "不同用途必须使用不同桶实例"
    assert sorted(_memory_stores) == ["bucket-skills", "bucket-snapshots"]

    skills.put("same-key", b"skill")
    snapshots.put("same-key", b"snapshot")
    assert skills.get("same-key") == b"skill"
    assert snapshots.get("same-key") == b"snapshot"

    # 同用途重复获取应为同一实例（避免每次新建连接/客户端）
    assert get_object_store("skills") is skills
    assert get_object_store("snapshots") is snapshots


def test_unknown_purpose_rejected() -> None:
    from huagent.storage.objects import get_object_store

    with pytest.raises(ValueError, match="未知存储用途"):
        get_object_store("avatars")
