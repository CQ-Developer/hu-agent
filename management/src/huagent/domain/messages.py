"""站内通知文案（design 5.13 / 6.3.1）：按收件人 `users.locale` 渲染。

设计取舍：通知在**写入时**按收件人语言渲染（而非读取时），
这样历史通知保持当时语言、读取路径零额外成本；参数（审批意见、停用原因等）原样保留。

模板语法：
- `{name}` 取参数；`{name|默认值}` 在参数缺失/为 None 时用默认值；
- 条目可带 `fragments`（命名片段，先渲染成参数再参与主模板），用于「可选补充说明」这类拼接。
缺少参数且无默认值时保留占位符原文，便于在库中直接发现遗漏。
"""

from __future__ import annotations

import re
from typing import Any, TypedDict

DEFAULT_LOCALE = "zh-CN"
SUPPORTED_LOCALES = ("zh-CN", "en-US")


class MessageTemplate(TypedDict, total=False):
    title: str
    body: str
    fragments: dict[str, str]


#: 审批类型（approval_requests.type）→ 本地化名称，供通知模板使用（避免把内部标识展示给用户）
APPROVAL_TYPE_NAMES: dict[str, dict[str, str]] = {
    "org_create": {"zh-CN": "创建组织", "en-US": "create an organization"},
    "team_create": {"zh-CN": "创建团队", "en-US": "create a team"},
    "skill_version_publish": {"zh-CN": "发布 Skill 版本", "en-US": "publish a Skill version"},
    "mcp_version_publish": {"zh-CN": "发布 MCP 版本", "en-US": "publish an MCP version"},
}

#: kind → locale → 模板
NOTIFICATION_MESSAGES: dict[str, dict[str, MessageTemplate]] = {
    "approval.approved": {
        "zh-CN": {"title": "审批已通过", "body": "{comment|你的申请已通过。}"},
        "en-US": {"title": "Approval approved", "body": "{comment|Your request was approved.}"},
    },
    "approval.rejected": {
        "zh-CN": {"title": "审批被驳回", "body": "{comment|申请被驳回，请联系审批人了解原因。}"},
        "en-US": {
            "title": "Approval rejected",
            "body": "{comment|The request was rejected; contact the approver for details.}",
        },
    },
    "approval.org_create": {
        "zh-CN": {"title": "新的组织创建申请", "body": "{actor} 申请创建组织「{name}」"},
        "en-US": {
            "title": "New organization request",
            "body": "{actor} requested to create the organization “{name}”",
        },
    },
    "approval.team_create": {
        "zh-CN": {"title": "新的团队创建申请", "body": "{actor} 申请创建团队「{name}」"},
        "en-US": {"title": "New team request", "body": "{actor} requested to create the team “{name}”"},
    },
    "approval.skill_version_publish": {
        "zh-CN": {"title": "待审批：{name} {version}", "body": "{actor} 提交了新版本，请审核后发布。"},
        "en-US": {
            "title": "Pending review: {name} {version}",
            "body": "{actor} submitted a new version — review and publish it.",
        },
    },
    "approval.mcp_version_publish": {
        "zh-CN": {"title": "待审批：MCP {name} v{version}", "body": "{actor} 提交了新版本，请审核后发布。"},
        "en-US": {
            "title": "Pending review: MCP {name} v{version}",
            "body": "{actor} submitted a new version — review and publish it.",
        },
    },
    "approval.reminder": {
        "zh-CN": {
            "title": "有待审批事项超过 48 小时",
            "body": "{actor} 的申请（{approval_type}）仍在等待处理。",
        },
        "en-US": {
            "title": "An approval has been pending for over 48 hours",
            "body": "{actor}'s request ({approval_type}) is still waiting for review.",
        },
    },
    "org.member.removed": {
        "zh-CN": {"title": "你已被移出组织", "body": "如有疑问请联系组织管理员。"},
        "en-US": {
            "title": "You were removed from the organization",
            "body": "Contact an organization admin if you have questions.",
        },
    },
    "org.invitation": {
        "zh-CN": {"title": "组织邀请", "body": "你被邀请加入组织，请在客户端「组织」页输入邀请码完成加入。"},
        "en-US": {
            "title": "Organization invitation",
            "body": (
                "You were invited to join an organization; enter the invitation code "
                "on the client's Organization page."
            ),
        },
    },
    "team.invitation": {
        "zh-CN": {"title": "团队邀请", "body": "你被邀请加入团队，请在客户端「组织」页输入邀请码完成加入。"},
        "en-US": {
            "title": "Team invitation",
            "body": "You were invited to join a team; enter the invitation code on the client's Organization page.",
        },
    },
    "team.member.removed": {
        "zh-CN": {"title": "你已被移出团队", "body": "已安装的市场资源需团队管理员重新授权后才能继续更新。"},
        "en-US": {
            "title": "You were removed from the team",
            "body": (
                "Installed marketplace resources need a team admin to re-authorize them "
                "before they can update again."
            ),
        },
    },
    "skill.disabled": {
        "zh-CN": {
            "title": "Skill「{name}」已被停用",
            "body": "{reason|管理员停用了该资源。}",
        },
        "en-US": {
            "title": "Skill “{name}” was disabled",
            "body": "{reason|An administrator disabled this resource.}",
        },
    },
    "skill.deleted": {
        "zh-CN": {"title": "Skill「{name}」已被删除", "body": "该资源已从市场删除，客户端将停止使用。"},
        "en-US": {
            "title": "Skill “{name}” was deleted",
            "body": "The resource was removed from the marketplace; clients stop using it.",
        },
    },
    "skill.version_revoked": {
        "zh-CN": {
            "title": "Skill「{name}」的版本 {version} 已被撤回",
            "body": "{reason|该版本已被撤回。}{upgrade}",
            "fragments": {"upgrade": "；请升级到 {replacement}"},
        },
        "en-US": {
            "title": "Version {version} of Skill “{name}” was revoked",
            "body": "{reason|This version was revoked.}{upgrade}",
            "fragments": {"upgrade": "; please upgrade to {replacement}"},
        },
    },
    "mcp.disabled": {
        "zh-CN": {
            "title": "MCP「{name}」已被停用",
            "body": "{reason|管理员停用了该资源。}",
        },
        "en-US": {
            "title": "MCP “{name}” was disabled",
            "body": "{reason|An administrator disabled this resource.}",
        },
    },
    "mcp.deleted": {
        "zh-CN": {"title": "MCP「{name}」已被删除", "body": "该资源已从市场删除，客户端将停止使用。"},
        "en-US": {
            "title": "MCP “{name}” was deleted",
            "body": "The resource was removed from the marketplace; clients stop using it.",
        },
    },
    "mcp.version_revoked": {
        "zh-CN": {
            "title": "MCP「{name}」的版本 {version} 已被撤回",
            "body": "{reason|该版本已被撤回。}{upgrade}",
            "fragments": {"upgrade": "；请升级到 v{replacement}"},
        },
        "en-US": {
            "title": "Version {version} of MCP “{name}” was revoked",
            "body": "{reason|This version was revoked.}{upgrade}",
            "fragments": {"upgrade": "; please upgrade to v{replacement}"},
        },
    },
}

# 撤回版本但未给出替代版本时，用一句后缀而不是空串，避免「；请升级到 」
UPGRADE_SUFFIX = {
    "zh-CN": "；请升级到其他版本。",
    "en-US": "; please upgrade to another version.",
}

_PLACEHOLDER = re.compile(r"\{(\w+)(?:\|([^{}]*))?\}")


def _render_template(template: str, params: dict[str, Any]) -> str:
    def replace(match: re.Match[str]) -> str:
        name, default = match.group(1), match.group(2)
        if name in params and params[name] is not None:
            return str(params[name])
        if default is not None:
            return default
        return match.group(0)  # 保留占位符原文，便于发现遗漏

    return _PLACEHOLDER.sub(replace, template)


def normalize_locale(value: str | None) -> str:
    if value and value.lower().startswith("en"):
        return "en-US"
    return DEFAULT_LOCALE


def render_notification(kind: str, locale: str | None, params: dict[str, Any]) -> tuple[str, str]:
    """渲染通知 (title, body)；未知 kind 回退到通用文案（不丢消息，便于排障）。"""
    resolved = normalize_locale(locale)
    entry = NOTIFICATION_MESSAGES.get(kind)
    if entry is None:
        fallback = {
            "zh-CN": ("系统通知", "你有一条新的通知。"),
            "en-US": ("System notification", "You have a new notification."),
        }
        title, body = fallback[resolved]
        return _render_template(title, params), _render_template(body, params)

    template = entry.get(resolved) or entry[DEFAULT_LOCALE]
    merged = dict(params)
    # approval_type 是内部标识，渲染前映射为本地化名称（未知值原样保留）
    if merged.get("approval_type") is not None:
        raw = str(merged["approval_type"])
        merged["approval_type"] = APPROVAL_TYPE_NAMES.get(raw, {}).get(resolved, raw)
    for name, fragment in (template.get("fragments") or {}).items():
        # 无替代版本时用固定后缀，避免出现「；请升级到 」这样的残句
        if name == "upgrade" and not params.get("replacement"):
            merged[name] = UPGRADE_SUFFIX[resolved]
            continue
        merged[name] = _render_template(fragment, params)
    return (
        _render_template(template.get("title", ""), merged),
        _render_template(template.get("body", ""), merged),
    )
