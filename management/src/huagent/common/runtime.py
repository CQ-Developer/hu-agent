"""运行环境适配。

Windows 下 asyncio 默认使用 ProactorEventLoop，而 psycopg 的 async 模式要求
SelectorEventLoop（否则报 "Psycopg cannot use the 'ProactorEventLoop'"）。
统一在进程入口用本模块的 loop factory，避免使用已废弃的 event loop policy。
"""

from __future__ import annotations

import asyncio
import selectors
import sys


def new_event_loop() -> asyncio.AbstractEventLoop:
    if sys.platform == "win32":
        return asyncio.SelectorEventLoop(selectors.SelectSelector())
    return asyncio.new_event_loop()
