"""通知文案渲染测试（design 5.13）：按收件人语言渲染、占位符与默认值行为。"""

from __future__ import annotations

import pytest

from huagent.domain.messages import (
    DEFAULT_LOCALE,
    NOTIFICATION_MESSAGES,
    normalize_locale,
    render_notification,
)


def test_render_by_locale() -> None:
    title_zh, body_zh = render_notification("org.invitation", "zh-CN", {})
    title_en, body_en = render_notification("org.invitation", "en-US", {})
    assert title_zh == "组织邀请"
    assert "输入邀请码" in body_zh
    assert title_en == "Organization invitation"
    assert "invitation code" in body_en


def test_unknown_locale_falls_back_to_default() -> None:
    assert normalize_locale("fr-FR") == DEFAULT_LOCALE
    assert normalize_locale("en-GB") == "en-US"
    assert normalize_locale(None) == DEFAULT_LOCALE
    assert render_notification("skill.deleted", "fr-FR", {"name": "x"})[0] == "Skill「x」已被删除"
    assert render_notification("skill.deleted", "en-GB", {"name": "x"})[0] == "Skill “x” was deleted"


def test_params_and_defaults() -> None:
    # 有审批意见：直接用意见
    assert render_notification("approval.approved", "zh-CN", {"comment": "干得漂亮"})[1] == "干得漂亮"
    # 无审批意见：用模板默认值
    assert render_notification("approval.approved", "zh-CN", {"comment": None})[1] == "你的申请已通过。"
    assert render_notification("approval.approved", "en-US", {})[1] == "Your request was approved."


def test_approval_type_is_localized() -> None:
    _, body_zh = render_notification("approval.reminder", "zh-CN", {"actor": "张三", "approval_type": "team_create"})
    _, body_en = render_notification("approval.reminder", "en-US", {"actor": "Zhang", "approval_type": "team_create"})
    assert "创建团队" in body_zh
    assert "create a team" in body_en
    # 未知类型原样保留（便于排查新类型漏配）
    _, unknown = render_notification("approval.reminder", "en-US", {"actor": "A", "approval_type": "new_kind"})
    assert "new_kind" in unknown


def test_revocation_with_and_without_replacement() -> None:
    _, with_replacement = render_notification(
        "skill.version_revoked",
        "zh-CN",
        {"name": "demo", "version": "1.0.0", "reason": "存在漏洞", "replacement": "1.0.1"},
    )
    assert with_replacement == "存在漏洞；请升级到 1.0.1"

    _, without_replacement = render_notification(
        "skill.version_revoked", "en-US", {"name": "demo", "version": "1.0.0", "reason": None}
    )
    assert without_replacement == "This version was revoked.; please upgrade to another version."


def test_unknown_kind_keeps_message() -> None:
    title, body = render_notification("brand.new.kind", "en-US", {})
    assert title == "System notification"
    assert body == "You have a new notification."


@pytest.mark.parametrize("kind", sorted(NOTIFICATION_MESSAGES))
def test_all_kinds_render_without_leftover_placeholders(kind: str) -> None:
    """每种通知在两种语言下都能渲染干净（无残留占位符、无空标题）。"""
    sample = {
        "actor": "A",
        "name": "n",
        "version": "1.0.0",
        "reason": "r",
        "replacement": "1.0.1",
        "comment": "c",
        "approval_type": "org_create",
    }
    for locale in ("zh-CN", "en-US"):
        title, body = render_notification(kind, locale, sample)
        assert title, f"{kind}/{locale} 标题为空"
        assert body, f"{kind}/{locale} 正文为空"
        assert "{" not in title and "}" not in title, f"{kind}/{locale} 标题残留占位符：{title}"
        assert "{" not in body and "}" not in body, f"{kind}/{locale} 正文残留占位符：{body}"
