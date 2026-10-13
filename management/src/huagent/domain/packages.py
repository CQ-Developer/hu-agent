"""技能包校验（design 6.4.2）：zip 结构、路径安全、大小/压缩比、front matter。"""

from __future__ import annotations

import hashlib
import io
import zipfile
from dataclasses import dataclass, field
from typing import Any

from huagent.domain.skill_frontmatter import (
    NAME_RE,
    SEMVER_RE,
    FrontMatterError,
    SkillFrontMatter,
    parse_skill_markdown,
    semver_lte,
)

SCRIPT_SUFFIXES = (
    ".sh",
    ".bash",
    ".ps1",
    ".bat",
    ".cmd",
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".rb",
    ".pl",
    ".exe",
)

SKILL_MD = "SKILL.md"


class PackageInvalidError(ValueError):
    """技能包不合法；message 直接返回给上传者。"""


@dataclass
class PackageFile:
    path: str
    size: int
    script: bool


@dataclass
class ValidatedPackage:
    digest: str
    size_bytes: int
    file_count: int
    files: list[PackageFile] = field(default_factory=list)
    front_matter: SkillFrontMatter | None = None
    body: str = ""
    root_prefix: str = ""

    @property
    def script_files(self) -> list[str]:
        return [item.path for item in self.files if item.script]


def safe_member_path(name: str) -> str:
    """规范化并校验 zip 内路径；非法则抛 PackageInvalidError。"""
    if name.startswith("/") or name.startswith("\\"):
        raise PackageInvalidError(f"包含绝对路径：{name}")
    if "\\" in name:
        raise PackageInvalidError(f"包含反斜杠路径（请使用 /）：{name}")
    if len(name) > 2 and name[1] == ":":
        raise PackageInvalidError(f"包含盘符路径：{name}")
    parts = [part for part in name.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise PackageInvalidError(f"包含上级目录引用：{name}")
    if not parts:
        raise PackageInvalidError(f"无效路径：{name}")
    return "/".join(parts)


def validate_skill_package(
    data: bytes,
    *,
    max_bytes: int,
    unpack_max_bytes: int,
    max_files: int,
    max_compression_ratio: int,
    current_app_version: str,
) -> ValidatedPackage:
    if len(data) == 0:
        raise PackageInvalidError("包内容为空")
    if len(data) > max_bytes:
        raise PackageInvalidError(f"包超过大小上限（{max_bytes // (1024 * 1024)} MB）")

    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise PackageInvalidError("文件不是合法的 zip（.hskill）包") from exc

    infos = [info for info in archive.infolist() if not info.is_dir()]
    if not infos:
        raise PackageInvalidError("包内没有文件")
    if len(infos) > max_files:
        raise PackageInvalidError(f"文件数超过上限（{max_files}）")

    total_uncompressed = 0
    files: list[PackageFile] = []
    for info in infos:
        path = safe_member_path(info.filename)
        if (info.external_attr >> 16) & 0o170000 == 0o120000:
            raise PackageInvalidError(f"包含符号链接：{path}")
        total_uncompressed += info.file_size
        if total_uncompressed > unpack_max_bytes:
            raise PackageInvalidError(f"解压后总大小超过上限（{unpack_max_bytes // (1024 * 1024)} MB）")
        suffix = path.lower().rsplit(".", 1)[-1] if "." in path else ""
        script = f".{suffix}" in SCRIPT_SUFFIXES if suffix else False
        files.append(PackageFile(path=path, size=info.file_size, script=script))

    if total_uncompressed / max(len(data), 1) > max_compression_ratio:
        raise PackageInvalidError("压缩比过高，疑似 zip 炸弹")

    skill_md_path = _locate_skill_md([item.path for item in files])
    root_prefix = skill_md_path[: -len(SKILL_MD)] if skill_md_path.endswith(SKILL_MD) else ""
    try:
        content = archive.read(skill_md_path).decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PackageInvalidError("SKILL.md 不是 UTF-8 编码") from exc

    try:
        front_matter, body = parse_skill_markdown(content)
    except FrontMatterError as exc:
        raise PackageInvalidError(str(exc)) from exc

    if not NAME_RE.match(front_matter.name):
        raise PackageInvalidError("front matter name 需为小写字母/数字/连字符（2-64 位）")
    if front_matter.version is not None and not SEMVER_RE.match(front_matter.version):
        raise PackageInvalidError("front matter version 需为 semver（如 1.2.0）")
    if front_matter.min_app_version and not semver_lte(front_matter.min_app_version, current_app_version):
        raise PackageInvalidError(
            f"该 Skill 要求客户端 >= {front_matter.min_app_version}，当前服务端最低支持版本为 {current_app_version}"
        )

    return ValidatedPackage(
        digest=f"sha256:{hashlib.sha256(data).hexdigest()}",
        size_bytes=len(data),
        file_count=len(files),
        files=files,
        front_matter=front_matter,
        body=body,
        root_prefix=root_prefix,
    )


def _locate_skill_md(paths: list[str]) -> str:
    """根目录 SKILL.md，或单一顶层目录下的 SKILL.md（design 6.4.2）。"""
    if SKILL_MD in paths:
        return SKILL_MD
    top_levels = {path.split("/", 1)[0] for path in paths}
    candidates = [path for path in paths if path.endswith(f"/{SKILL_MD}")]
    if len(candidates) == 1 and len(top_levels) == 1:
        return candidates[0]
    raise PackageInvalidError("包内需在根目录或单一顶层目录下包含 SKILL.md")


def package_manifest(package: ValidatedPackage) -> dict[str, Any]:
    front = package.front_matter
    return {
        "frontMatter": {
            "name": front.name if front else None,
            "description": front.description if front else None,
            "version": front.version if front else None,
            "whenToUse": front.when_to_use if front else None,
            "minAppVersion": front.min_app_version if front else None,
            "tags": list(front.tags) if front else [],
            "requires": {
                "tools": list(front.requires.tools) if front else [],
                "bins": list(front.requires.bins) if front else [],
                "network": front.requires.network if front else False,
            },
        },
        "files": [{"path": item.path, "size": item.size, "script": item.script} for item in package.files],
        "scripts": package.script_files,
        "rootPrefix": package.root_prefix,
    }
