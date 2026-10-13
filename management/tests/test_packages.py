"""技能包校验单测（design 6.4.2）：zip 安全、front matter、版本与大小限制。"""

from __future__ import annotations

import io
import zipfile

import pytest

from huagent.domain.packages import (
    PackageInvalidError,
    package_manifest,
    safe_member_path,
    validate_skill_package,
)
from huagent.domain.skill_frontmatter import (
    FrontMatterError,
    parse_skill_markdown,
    semver_lte,
)

SKILL_MD = """---
name: pdf-report
description: 导出 PDF 报表
version: 1.2.0
when_to_use: 用户要求导出 PDF 时
requires:
  tools: [bash, read_file]
  bins: [pandoc]
  network: false
tags: [report, pdf]
min_app_version: 0.1.0
---

# 使用说明

第一步：读取模板。
"""

LIMITS = {
    "max_bytes": 20 * 1024 * 1024,
    "unpack_max_bytes": 100 * 1024 * 1024,
    "max_files": 500,
    "max_compression_ratio": 200,
    "current_app_version": "0.1.0",
}


def make_zip(entries: dict[str, bytes | str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def test_parse_front_matter_subset() -> None:
    front, body = parse_skill_markdown(SKILL_MD)
    assert front.name == "pdf-report"
    assert front.version == "1.2.0"
    assert front.requires.tools == ["bash", "read_file"]
    assert front.requires.bins == ["pandoc"]
    assert front.requires.network is False
    assert front.tags == ["report", "pdf"]
    assert "使用说明" in body


def test_parse_front_matter_errors() -> None:
    with pytest.raises(FrontMatterError):
        parse_skill_markdown("# 没有 front matter")
    with pytest.raises(FrontMatterError):
        parse_skill_markdown("---\nname: only\n---\nbody")


def test_semver_compare() -> None:
    assert semver_lte("0.1.0", "0.2.0")
    assert semver_lte("1.0.0", "1.0.0")
    assert not semver_lte("1.1.0", "1.0.9")


def test_safe_member_path_rejects_unsafe() -> None:
    assert safe_member_path("a/b.txt") == "a/b.txt"
    for bad in ("/abs.txt", "..\\evil.txt", "a/../../evil", "C:/x.txt", "a\\b.txt"):
        with pytest.raises(PackageInvalidError):
            safe_member_path(bad)


def test_reject_backslash_entries_smuggled_via_zipfile_normalization() -> None:
    """PowerShell Compress-Archive 会写出 `scripts\\run.sh` 这类原始名；
    Python zipfile 的 filename 会归一化为 /（orig_filename 保留原样），必须按 orig_filename 校验。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("SKILL.md"), SKILL_MD)
        entry = zipfile.ZipInfo("scripts/run.sh")
        entry.filename = "scripts\\run.sh"  # 绕过构造函数归一化，模拟 Windows 压缩工具产物
        archive.writestr(entry, "#!/bin/sh\n")
    with pytest.raises(PackageInvalidError):
        validate_skill_package(buffer.getvalue(), **LIMITS)


def test_validate_valid_package() -> None:
    data = make_zip({"SKILL.md": SKILL_MD, "scripts/run.sh": "#!/bin/sh\necho hi\n", "assets/logo.png": b"\x89PNG"})
    package = validate_skill_package(data, **LIMITS)
    assert package.digest.startswith("sha256:")
    assert package.file_count == 3
    assert "scripts/run.sh" in package.script_files
    manifest = package_manifest(package)
    assert manifest["frontMatter"]["requires"]["tools"] == ["bash", "read_file"]
    assert manifest["scripts"] == ["scripts/run.sh"]


def test_validate_accepts_single_top_level_dir() -> None:
    data = make_zip({"pdf-report/SKILL.md": SKILL_MD, "pdf-report/README.md": "hi"})
    package = validate_skill_package(data, **LIMITS)
    assert package.root_prefix == "pdf-report/"


def test_reject_missing_skill_md_and_ambiguous_layout() -> None:
    with pytest.raises(PackageInvalidError):
        validate_skill_package(make_zip({"README.md": "hi"}), **LIMITS)
    with pytest.raises(PackageInvalidError):
        validate_skill_package(make_zip({"a/SKILL.md": SKILL_MD, "b/README.md": "hi"}), **LIMITS)


def test_reject_zip_slip_and_symlink() -> None:
    with pytest.raises(PackageInvalidError):
        validate_skill_package(make_zip({"../evil.sh": "x", "SKILL.md": SKILL_MD}), **LIMITS)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("SKILL.md", SKILL_MD)
        info = zipfile.ZipInfo("link")
        info.external_attr = (0o120777 << 16)  # symlink
        archive.writestr(info, "target")
    with pytest.raises(PackageInvalidError):
        validate_skill_package(buffer.getvalue(), **LIMITS)


def test_reject_too_many_files_and_high_ratio() -> None:
    many = {f"f{i}.txt": "x" for i in range(10)}
    many["SKILL.md"] = SKILL_MD
    with pytest.raises(PackageInvalidError):
        validate_skill_package(make_zip(many), **{**LIMITS, "max_files": 5})

    bomb = make_zip({"SKILL.md": SKILL_MD, "big.txt": "0" * 2_000_000})
    with pytest.raises(PackageInvalidError):
        validate_skill_package(bomb, **{**LIMITS, "max_compression_ratio": 3})


def test_reject_bad_front_matter_fields() -> None:
    bad_name = SKILL_MD.replace("name: pdf-report", "name: PDF Report")
    with pytest.raises(PackageInvalidError):
        validate_skill_package(make_zip({"SKILL.md": bad_name}), **LIMITS)

    bad_version = SKILL_MD.replace("version: 1.2.0", "version: v1")
    with pytest.raises(PackageInvalidError):
        validate_skill_package(make_zip({"SKILL.md": bad_version}), **LIMITS)

    too_new = SKILL_MD.replace("min_app_version: 0.1.0", "min_app_version: 9.0.0")
    with pytest.raises(PackageInvalidError):
        validate_skill_package(make_zip({"SKILL.md": too_new}), **LIMITS)

    with pytest.raises(PackageInvalidError):
        validate_skill_package(b"not a zip", **LIMITS)
