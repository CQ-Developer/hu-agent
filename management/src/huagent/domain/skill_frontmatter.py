"""SKILL.md front matter 解析（服务端侧，与客户端 parser.ts 保持同一子集）。

只支持设计约定的字段：name/description/version/when_to_use/requires/tags/min_app_version。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

FRONT_MATTER_MISSING = "SKILL.md 缺少 front matter（应以 --- 开头）"


class FrontMatterError(ValueError):
    """front matter 结构非法。"""


@dataclass
class SkillRequires:
    tools: list[str] = field(default_factory=list)
    bins: list[str] = field(default_factory=list)
    network: bool = False


@dataclass
class SkillFrontMatter:
    name: str
    description: str
    version: str | None = None
    when_to_use: str | None = None
    requires: SkillRequires = field(default_factory=SkillRequires)
    tags: list[str] = field(default_factory=list)
    min_app_version: str | None = None


def parse_skill_markdown(content: str) -> tuple[SkillFrontMatter, str]:
    normalized = content.replace("\r\n", "\n")
    if not normalized.startswith("---\n"):
        raise FrontMatterError(FRONT_MATTER_MISSING)
    end = normalized.find("\n---", 4)
    if end < 0:
        raise FrontMatterError("SKILL.md front matter 未闭合（缺少结束的 ---）")
    raw = parse_yaml_subset(normalized[4:end])
    body = normalized[end + 4 :].lstrip("\n")

    name = _as_str(raw.get("name"))
    description = _as_str(raw.get("description"))
    if not name:
        raise FrontMatterError("front matter 缺少 name")
    if not description:
        raise FrontMatterError("front matter 缺少 description")

    requires_raw = raw.get("requires")
    requires = SkillRequires()
    if isinstance(requires_raw, dict):
        requires = SkillRequires(
            tools=_as_str_list(requires_raw.get("tools")),
            bins=_as_str_list(requires_raw.get("bins")),
            network=requires_raw.get("network") is True,
        )
    return (
        SkillFrontMatter(
            name=name,
            description=description,
            version=_as_str(raw.get("version")),
            when_to_use=_as_str(raw.get("when_to_use")),
            requires=requires,
            tags=_as_str_list(raw.get("tags")),
            min_app_version=_as_str(raw.get("min_app_version")),
        ),
        body,
    )


def parse_yaml_subset(text: str) -> dict[str, Any]:
    """Skill front matter 所需的 YAML 子集：一层嵌套、块列表、内联列表、布尔、字符串。"""
    lines = [
        (len(line) - len(line.lstrip()), line.strip())
        for line in text.split("\n")
        if line.strip() and not line.strip().startswith("#")
    ]
    root: dict[str, Any] = {}
    index = 0

    def parse_block(indent: int) -> dict[str, Any] | list[str]:
        nonlocal index
        first = lines[index] if index < len(lines) else None
        if first is None:
            return {}
        is_list = first[1].startswith("- ")
        container: dict[str, Any] | list[str] = [] if is_list else {}
        while index < len(lines):
            current_indent, current = lines[index]
            if current_indent < indent:
                break
            if current_indent > indent:
                break
            if isinstance(container, list):
                if not current.startswith("- "):
                    break
                container.append(_strip_quotes(current[2:].strip()))
                index += 1
                continue
            colon = current.find(":")
            if colon < 0:
                break
            key = current[:colon].strip()
            value_text = current[colon + 1 :].strip()
            index += 1
            if value_text:
                container[key] = _scalar(value_text)
                continue
            child = lines[index] if index < len(lines) else None
            if child is not None and child[0] > current_indent:
                container[key] = parse_block(child[0])
            else:
                container[key] = {}
        return container

    while index < len(lines):
        current_indent, current = lines[index]
        if current_indent != 0:
            break
        colon = current.find(":")
        if colon < 0:
            break
        key = current[:colon].strip()
        value_text = current[colon + 1 :].strip()
        index += 1
        if value_text:
            root[key] = _scalar(value_text)
            continue
        child = lines[index] if index < len(lines) else None
        if child is not None and child[0] > 0:
            root[key] = parse_block(child[0])
        else:
            root[key] = {}
    return root


def _scalar(text: str) -> Any:
    if text == "true":
        return True
    if text == "false":
        return False
    if text.startswith("[") and text.endswith("]"):
        return [_strip_quotes(item.strip()) for item in text[1:-1].split(",") if item.strip()]
    return _strip_quotes(text)


def _strip_quotes(text: str) -> str:
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    return text


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _as_str_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


SEMVER_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")


def parse_semver(value: str) -> tuple[int, int, int]:
    core = value.split("-")[0] or ""
    major, minor, patch = core.split(".")
    return int(major), int(minor), int(patch)


def semver_lte(left: str, right: str) -> bool:
    """left <= right（忽略 pre-release，用于 min_app_version 比较）。"""
    return parse_semver(left) <= parse_semver(right)
