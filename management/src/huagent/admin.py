"""管理员 CLI（`uv run huagent-admin ...`）。

自托管部署后的第一件事通常是"让我的账号成为系统管理员"——此前只能手写 SQL，
本 CLI 提供最小可用的运维入口，均直接操作数据库（不走 HTTP）：

    huagent-admin db-migrate
    huagent-admin create-admin --email admin@example.com
    huagent-admin reset-password --email admin@example.com
    huagent-admin list-users
    huagent-admin disable-user --email someone@example.com
    huagent-admin enable-user --email someone@example.com

约定：
- 未提供 `--password` 时生成一次性强口令并打印（只显示一次，请立即转交本人并让其修改）；
- 口令强度与注册接口使用同一套校验（长度、弱口令名单）；
- 所有写操作打印结果并写入审计（action=admin.cli.*），便于与界面操作对齐追溯。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import secrets
import string
import sys
from pathlib import Path
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from huagent.common.config import get_settings
from huagent.common.runtime import new_event_loop
from huagent.common.security import hash_password, validate_password
from huagent.domain.audit import record_audit
from huagent.domain.db import get_session_factory
from huagent.domain.schema import verify_schema

SELECT_USER = text(
    """
    SELECT id, email, display_name, status, is_system_admin, created_at
    FROM users WHERE lower(email) = lower(:email)
    """
)
SELECT_USER_BY_ID = text(
    """
    SELECT id, email, display_name, status, is_system_admin, created_at
    FROM users WHERE id = :user_id
    """
)
INSERT_USER = text(
    """
    INSERT INTO users (email, password_hash, display_name, status, is_system_admin)
    VALUES (:email, :password_hash, :display_name, 'active', true)
    RETURNING id, email, display_name, status, is_system_admin
    """
)
PROMOTE_USER = text(
    """
    UPDATE users SET is_system_admin = true, status = 'active', updated_at = now()
    WHERE id = :user_id
    RETURNING id, email, display_name, status, is_system_admin
    """
)
SET_PASSWORD = text(
    "UPDATE users SET password_hash = :password_hash, updated_at = now() WHERE id = :user_id"
)
REVOKE_TOKENS = text("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = :user_id AND revoked_at IS NULL")
SET_STATUS = text(
    "UPDATE users SET status = :status, updated_at = now() WHERE id = :user_id RETURNING id, email, status"
)
LIST_USERS = text(
    """
    SELECT id, email, display_name, status, is_system_admin, created_at
    FROM users
    WHERE :query = '' OR email ILIKE '%' || :query || '%' OR display_name ILIKE '%' || :query || '%'
    ORDER BY created_at DESC LIMIT :limit
    """
)


def _generate_password() -> str:
    """生成一次性强口令（20 位，含大小写/数字/符号）。"""
    alphabet = string.ascii_letters + string.digits + "!@#$%^&*-_"
    while True:
        candidate = "".join(secrets.choice(alphabet) for _ in range(20))
        try:
            validate_password(candidate)
        except ValueError:
            continue
        return candidate


def _password_or_generated(value: str | None, *, email: str) -> tuple[str, bool]:
    if value:
        validate_password(value)
        return value, False
    candidate = _generate_password()
    print(f"[huagent-admin] 已为 {email} 生成一次性口令（仅本次显示）：{candidate}")
    return candidate, True


async def _create_admin(args: argparse.Namespace, session: AsyncSession) -> int:
    existing = (await session.execute(SELECT_USER, {"email": args.email})).mappings().first()
    if existing and not args.force:
        promoted = (await session.execute(PROMOTE_USER, {"user_id": existing["id"]})).mappings().one()
        password, generated = _password_or_generated(args.password, email=args.email)
        await session.execute(SET_PASSWORD, {"user_id": existing["id"], "password_hash": hash_password(password)})
        await session.execute(REVOKE_TOKENS, {"user_id": existing["id"]})
        await record_audit(
            session,
            action="admin.cli.promote",
            actor_id=existing["id"],
            target_type="user",
            target_id=str(existing["id"]),
            detail={"email": args.email, "generatedPassword": generated},
        )
        await session.commit()
        print(f"[huagent-admin] 已将现有账号提升为系统管理员：{promoted['email']}（状态 {promoted['status']}）")
        return 0

    password, generated = _password_or_generated(args.password, email=args.email)
    row = (
        await session.execute(
            INSERT_USER,
            {
                "email": args.email,
                "password_hash": hash_password(password),
                "display_name": args.display_name or args.email.split("@")[0],
            },
        )
    ).mappings().one()
    await record_audit(
        session,
        action="admin.cli.create_admin",
        actor_id=row["id"],
        target_type="user",
        target_id=str(row["id"]),
        detail={"email": args.email, "generatedPassword": generated},
    )
    await session.commit()
    print(f"[huagent-admin] 已创建系统管理员：{row['email']}（id={row['id']}）")
    return 0


async def _reset_password(args: argparse.Namespace, session: AsyncSession) -> int:
    existing = (await session.execute(SELECT_USER, {"email": args.email})).mappings().first()
    if existing is None:
        print(f"[huagent-admin] 账号不存在：{args.email}", file=sys.stderr)
        return 1
    password, generated = _password_or_generated(args.password, email=args.email)
    await session.execute(SET_PASSWORD, {"user_id": existing["id"], "password_hash": hash_password(password)})
    revoked = await session.execute(REVOKE_TOKENS, {"user_id": existing["id"]})
    await record_audit(
        session,
        action="admin.cli.reset_password",
        actor_id=existing["id"],
        target_type="user",
        target_id=str(existing["id"]),
        detail={
            "email": args.email,
            "generatedPassword": generated,
            "revokedTokens": int(getattr(revoked, "rowcount", 0) or 0),
        },
    )
    await session.commit()
    revoked_count = int(getattr(revoked, "rowcount", 0) or 0)
    print(f"[huagent-admin] 已重置 {args.email} 的密码，并撤销其全部会话（{revoked_count} 个刷新令牌）")
    return 0


async def _list_users(args: argparse.Namespace, session: AsyncSession) -> int:
    rows = (await session.execute(LIST_USERS, {"query": args.query or "", "limit": args.limit})).mappings().all()
    if not rows:
        print("[huagent-admin] 没有匹配的账号")
        return 0
    print(f"{'email':40} {'name':16} {'status':9} {'sysadmin':8} created")
    for row in rows:
        print(
            f"{str(row['email'])[:40]:40} {str(row['display_name'])[:16]:16} {row['status']:9} "
            f"{'yes' if row['is_system_admin'] else 'no':8} {row['created_at']:%Y-%m-%d %H:%M}"
        )
    print(f"[huagent-admin] 共 {len(rows)} 条（最多 {args.limit}）")
    return 0


async def _set_status(args: argparse.Namespace, session: AsyncSession, status: str) -> int:
    if args.user_id:
        try:
            user_id = UUID(args.user_id)
        except ValueError:
            print(f"[huagent-admin] --user-id 不是合法 UUID：{args.user_id}", file=sys.stderr)
            return 1
        existing = (await session.execute(SELECT_USER_BY_ID, {"user_id": user_id})).mappings().first()
    else:
        existing = (await session.execute(SELECT_USER, {"email": args.email})).mappings().first()
    if existing is None:
        print(f"[huagent-admin] 账号不存在：{args.email or args.user_id}", file=sys.stderr)
        return 1

    row = (
        await session.execute(SET_STATUS, {"user_id": existing["id"], "status": status})
    ).mappings().one()
    if status == "disabled":
        await session.execute(REVOKE_TOKENS, {"user_id": row["id"]})
    await record_audit(
        session,
        action=f"admin.cli.{'disable' if status == 'disabled' else 'enable'}_user",
        actor_id=row["id"],
        target_type="user",
        target_id=str(row["id"]),
        detail={"email": row["email"]},
    )
    await session.commit()
    print(f"[huagent-admin] 已{'禁用' if status == 'disabled' else '启用'}账号：{row['email']}")
    return 0


async def _db_migrate(args: argparse.Namespace, session: AsyncSession) -> int:
    """按编号顺序应用 db/ddl/V*.sql（幂等：已记录的版本跳过）。"""
    directory = _ddl_directory()
    files = sorted(directory.glob("V*.sql"))
    if not files:
        print(f"[huagent-admin] 未找到 DDL 文件：{directory}", file=sys.stderr)
        return 2

    applied = set()
    exists = (
        await session.execute(text("SELECT to_regclass('public.schema_versions') IS NOT NULL"))
    ).scalar_one()
    if exists:
        applied = {row[0] for row in (await session.execute(text("SELECT version FROM schema_versions"))).all()}

    pending = [path for path in files if path.name.split("_", 1)[0] not in applied]
    if not pending:
        print(f"[huagent-admin] 数据库已是最新（{len(applied)} 个版本）")
        return 0
    if args.dry_run:
        for path in pending:
            print(f"[huagent-admin][dry-run] 将应用 {path.name}")
        return 0

    for path in pending:
        print(f"[huagent-admin] 应用 {path.name}")
        await session.execute(text(path.read_text(encoding="utf-8")))
        await session.commit()
    print(f"[huagent-admin] DDL 应用完成（本次 {len(pending)} 个；共 {len(applied) + len(pending)} 个版本）")
    return 0


def _ddl_directory() -> Path:
    """DDL 目录：容器内 /app/db/ddl，源码运行时按仓库相对路径，可用 HUAGENT_DDL_DIR 覆盖。"""
    candidates = []
    override = os.environ.get("HUAGENT_DDL_DIR")
    if override:
        candidates.append(Path(override))
    candidates.append(Path("/app/db/ddl"))
    # src/huagent/admin.py → 仓库根/db/ddl
    candidates.append(Path(__file__).resolve().parents[3] / "db" / "ddl")
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return candidates[-1]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="huagent-admin", description="hu-agent 服务端运维 CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    migrate = sub.add_parser("db-migrate", help="应用 db/ddl/V*.sql（幂等，按版本记录跳过）")
    migrate.add_argument("--dry-run", action="store_true", help="只列出待应用的版本")

    create = sub.add_parser("create-admin", help="创建（或提升）系统管理员账号")
    create.add_argument("--email", required=True)
    create.add_argument("--password", help="不传则生成一次性口令并打印")
    create.add_argument("--display-name")
    create.add_argument("--force", action="store_true", help="账号已存在时仍按新建处理（不提升）")

    reset = sub.add_parser("reset-password", help="重置密码并撤销该账号全部会话")
    reset.add_argument("--email", required=True)
    reset.add_argument("--password")

    listing = sub.add_parser("list-users", help="列出账号")
    listing.add_argument("--query", help="按邮箱/昵称模糊搜索")
    listing.add_argument("--limit", type=int, default=50)

    for name, help_text in (("disable-user", "禁用账号并撤销其会话"), ("enable-user", "启用账号")):
        cmd = sub.add_parser(name, help=help_text)
        cmd.add_argument("--email", required=True)
        cmd.add_argument("--user-id", help="也可直接指定用户 UUID")

    return parser


async def _dispatch(args: argparse.Namespace) -> int:
    async with get_session_factory()() as session:
        # 迁移命令自身不校验版本（它就是把库升到期望版本的工具）
        if args.command == "db-migrate":
            return await _db_migrate(args, session)

        try:
            await verify_schema(get_settings().schema_expected_version)
        except Exception as error:  # noqa: BLE001 —— CLI 需要把原因原样告诉运维
            print(f"[huagent-admin] 数据库校验失败：{error}；可先执行 huagent-admin db-migrate", file=sys.stderr)
            return 2

        if args.command == "create-admin":
            return await _create_admin(args, session)
        if args.command == "reset-password":
            return await _reset_password(args, session)
        if args.command == "list-users":
            return await _list_users(args, session)
        if args.command == "disable-user":
            return await _set_status(args, session, "disabled")
        if args.command == "enable-user":
            return await _set_status(args, session, "active")
    return 1


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return asyncio.run(_dispatch(args), loop_factory=new_event_loop)


if __name__ == "__main__":
    raise SystemExit(main())
