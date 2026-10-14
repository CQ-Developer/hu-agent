#!/usr/bin/env python3
"""服务端性能基准（标准库实现，仅用于得出基线与容量拐点）。

场景与真实客户端请求形状一致（见 app/src/main/sync/backend.ts、cloud/client.ts）：
- login        登录（argon2id 校验 + 设备/会话写入，服务端 CPU 密集路径）
- usage:batch  用量上报（50 条/批：校验 + 幂等判定 + 分区写入）
- stats        统计查询（库侧聚合，按天分组）
- snapshot     快照上传（init → 预签名直传对象存储 → complete 流式 sha256 校验）

用法：
    uv run --project management python scripts/benchmark.py --scenario all --concurrency 8
    uv run --project management python scripts/benchmark.py --scenario usage --concurrency 1,4,16 --iterations 20

说明：本脚本用于单机自测（应用/PG/MinIO 同机），数值仅代表**该环境下限**；
生产容量结论需在 staging 以目标拓扑复测（见 docs/delivery/performance.md）。
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable

API = os.environ.get("HUAGENT_API", "http://127.0.0.1:8080")
EMAIL = os.environ.get("HUAGENT_E2E_EMAIL", "member@example.com")
PASSWORD = os.environ.get("HUAGENT_E2E_PASSWORD", "Str0ng-Passphrase-2026")
BATCH_SIZE = 50
SNAPSHOT_BYTES = 1024 * 1024  # 1 MiB（压缩后可上传内容，贴近小工作空间快照）


def request(
    path: str,
    *,
    method: str = "GET",
    token: str | None = None,
    body: Any = None,
    raw: bytes | None = None,
    content_type: str = "application/json",
    timeout: float = 120,
) -> tuple[int, Any]:
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(f"{API}{path}", data=data, method=method)  # noqa: S310
    req.add_header("content-type", content_type)
    req.add_header("x-client-version", "0.1.0")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:  # noqa: S310
            payload = response.read()
            return response.status, json.loads(payload) if payload[:1] in (b"{", b"[") else payload
    except urllib.error.HTTPError as error:
        return error.code, error.read()[:200]


def login() -> str:
    payload = {
        "email": EMAIL,
        "password": PASSWORD,
        "device": {"deviceId": f"bench-{uuid.uuid4().hex[:8]}", "platform": "linux", "appVersion": "0.1.0"},
    }
    status, body = request("/api/v1/auth/login", method="POST", body=payload)
    if status == 401:  # 首次运行：注册基准专用账号
        request(
            "/api/v1/auth/register",
            method="POST",
            body={"email": EMAIL, "password": PASSWORD, "displayName": "bench"},
        )
        status, body = request("/api/v1/auth/login", method="POST", body=payload)
    if status != 200:
        raise SystemExit(f"登录失败（{status}）：{body}")
    return body["accessToken"]


def usage_events() -> list[dict[str, Any]]:
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    return [
        {
            "eventId": str(uuid.uuid4()),
            "occurredAt": now,
            "deviceId": "bench",
            "provider": "deepseek",
            "model": "bench-model",
            "inputTokens": 1200,
            "outputTokens": 300,
            "requests": 1,
            "durationMs": 900,
            "status": "success",
        }
        for _ in range(BATCH_SIZE)
    ]


@dataclass
class Scenario:
    name: str
    run: Callable[[str, dict[str, Any]], None]
    setup: Callable[[str], dict[str, Any]] = lambda _token: {}  # noqa: E731


def _snapshot_payload(seq: int, base_version: int) -> tuple[bytes, dict[str, Any]]:
    """构造与客户端一致的 zip + manifest + 摘要（内容随机以禁用对象存储去重收益）。"""
    body = os.urandom(SNAPSHOT_BYTES)
    manifest = [{"path": f"src/file-{seq % 32}.bin", "size": SNAPSHOT_BYTES}]
    manifest_digest = hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()
    return body, {
        "baseVersion": base_version,
        "sizeBytes": len(body),
        "fileCount": len(manifest),
        "manifestDigest": manifest_digest,
        "manifest": manifest,
        "comment": "bench",
    }


def _workspace(token: str, name: str) -> str:
    status, workspaces = request("/api/v1/workspaces", token=token)
    if status != 200:
        raise SystemExit(f"读取工作空间失败（{status}）：{workspaces}")
    for workspace in workspaces:
        if workspace["name"] == name:
            return str(workspace["id"])
    status, created = request("/api/v1/workspaces", method="POST", token=token, body={"name": name})
    if status != 201:
        raise SystemExit(f"创建工作空间失败（{status}）：{created}")
    return str(created["id"])


def _snapshot_run(token: str, ctx: dict[str, Any]) -> None:
    # 每个工作线程独占一个工作空间，避免乐观锁（baseVersion）相互冲突
    import threading

    ident = threading.get_ident()
    workspace = ctx["workspaces"].setdefault(ident, _workspace(token, f"bench-{ident % 10000}"))
    seq = ctx["seq"]
    ctx["seq"] += 1
    latest = request(f"/api/v1/workspaces/{workspace}/snapshots/latest", token=token)
    base_version = latest[1]["version"] if latest[0] == 200 else 0
    body, payload = _snapshot_payload(seq, base_version)
    status, init = request(
        f"/api/v1/workspaces/{workspace}/snapshots:init", method="POST", token=token, body=payload
    )
    if status not in (200, 201):
        raise RuntimeError(f"init 失败（{status}）：{str(init)[:160]}")
    digest = f"sha256:{hashlib.sha256(body).hexdigest()}"  # 与服务端 store.digest() 格式一致
    # 预签名直传（与客户端一致：必须带 content-length）
    put = urllib.request.Request(init["uploadUrl"], data=body, method="PUT")  # noqa: S310
    put.add_header("content-type", "application/zip")
    put.add_header("content-length", str(len(body)))
    with urllib.request.urlopen(put, timeout=120) as response:  # noqa: S310
        if response.status not in (200, 204):
            raise RuntimeError(f"上传失败（HTTP {response.status}）")
    status, completed = request(
        f"/api/v1/snapshots/{init['snapshotId']}:complete", method="POST", token=token, body={"digest": digest}
    )
    if status != 200:
        raise RuntimeError(f"complete 失败（{status}）：{str(completed)[:160]}")


def _usage_run(token: str, _ctx: dict[str, Any]) -> None:
    status, body = request("/api/v1/usage:batch", method="POST", token=token, body={"events": usage_events()})
    handled = body.get("accepted", 0) + body.get("duplicated", 0) if isinstance(body, dict) else 0
    if status != 200 or handled != BATCH_SIZE:
        raise RuntimeError(f"上报失败（{status}）：{str(body)[:160]}")


def _stats_run(token: str, _ctx: dict[str, Any]) -> None:
    today = time.strftime("%Y-%m-%d", time.gmtime())
    status, body = request(
        f"/api/v1/stats/usage?scope=self&from={today}&to={today}&groupBy=day&tz=UTC", token=token
    )
    if status != 200:
        raise RuntimeError(f"统计查询失败（{status}）：{body}")


SCENARIOS: dict[str, Scenario] = {
    "login": Scenario(
        name="login 登录",
        run=lambda _token, _ctx: login(),
    ),
    "usage": Scenario(name=f"usage:batch 用量上报（{BATCH_SIZE} 条/批）", run=_usage_run),
    "stats": Scenario(name="stats 统计查询（按天）", run=_stats_run),
    "snapshot": Scenario(
        name=f"snapshot 快照上传（{SNAPSHOT_BYTES // 1024} KiB）",
        run=_snapshot_run,
        setup=lambda _token: {"workspaces": {}, "seq": 0},
    ),
}


@dataclass
class Result:
    concurrency: int
    iterations: int
    latencies: list[float] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    wall: float = 0.0

    def percentiles(self) -> dict[str, float]:
        if not self.latencies:
            return {}
        ordered = sorted(self.latencies)
        return {
            "p50": statistics.median(ordered),
            "p95": ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))],
            "p99": ordered[min(len(ordered) - 1, int(len(ordered) * 0.99))],
            "max": ordered[-1],
        }

    @property
    def throughput(self) -> float:
        return len(self.latencies) / self.wall if self.wall else 0.0


def bench(scenario: Scenario, token: str, concurrency: int, iterations: int) -> Result:
    ctx = scenario.setup(token)
    counter: list[int] = [0]
    lock = __import__("threading").Lock()

    def worker() -> tuple[float, str | None]:
        with lock:
            index = counter[0]
            counter[0] += 1
        if index >= iterations:
            return 0.0, None
        started = time.perf_counter()
        try:
            scenario.run(token, ctx)
            return time.perf_counter() - started, None
        except Exception as error:  # noqa: BLE001 —— 基准需记录失败而继续
            return time.perf_counter() - started, f"{type(error).__name__}: {error}"[:200]

    result = Result(concurrency=concurrency, iterations=iterations)
    wall_start = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
        for latency, error in pool.map(lambda _: worker(), range(iterations)):
            if error:
                result.errors.append(error)
            else:
                result.latencies.append(latency)
    result.wall = time.perf_counter() - wall_start
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", default="all", help="all 或逗号分隔：login,usage,stats,snapshot")
    parser.add_argument("--concurrency", default="8", help="并发数，可逗号分隔（如 1,4,16）")
    parser.add_argument("--iterations", type=int, default=30, help="每个并发档的总请求数")
    parser.add_argument("--json", help="将结果写入 JSON 文件")
    parser.add_argument("--markdown", help="将结果以 markdown 表格打印（用于文档）")
    args = parser.parse_args()

    names = list(SCENARIOS) if args.scenario == "all" else [item.strip() for item in args.scenario.split(",")]
    concurrencies = [int(item) for item in args.concurrency.split(",")]

    token = login()
    print(f"已登录（{EMAIL}，{API}）\n")

    rows: list[dict[str, Any]] = []
    for name in names:
        scenario = SCENARIOS[name]
        for concurrency in concurrencies:
            result = bench(scenario, token, concurrency, args.iterations)
            stats = result.percentiles()
            row = {
                "scenario": name,
                "label": scenario.name,
                "concurrency": concurrency,
                "iterations": result.iterations,
                "ok": len(result.latencies),
                "errors": len(result.errors),
                "throughput_rps": round(result.throughput, 1),
                **{key: round(value * 1000, 1) for key, value in stats.items()},
            }
            rows.append(row)
            print(
                f"{scenario.name:34} c={concurrency:<3} ok={row['ok']:<4} err={row['errors']:<3} "
                f"rps={row['throughput_rps']:>7} p50={row.get('p50', 0):>7}ms p95={row.get('p95', 0):>7}ms "
                f"p99={row.get('p99', 0):>7}ms"
            )
            if result.errors:
                print(f"    首个错误：{result.errors[0]}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(rows, handle, ensure_ascii=False, indent=2)
        print(f"\nJSON 结果已写入 {args.json}")
    if args.markdown:
        with open(args.markdown, "w", encoding="utf-8") as handle:
            handle.write("| 场景 | 并发 | 成功 | 失败 | 吞吐 (rps) | P50 | P95 | P99 | Max |\n")
            handle.write("| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n")
            for row in rows:
                handle.write(
                    f"| {row['label']} | {row['concurrency']} | {row['ok']} | {row['errors']} | "
                    f"{row['throughput_rps']} | {row.get('p50', 0)} ms | {row.get('p95', 0)} ms | "
                    f"{row.get('p99', 0)} ms | {row.get('max', 0)} ms |\n"
                )
        print(f"markdown 表格已写入 {args.markdown}")
    return 1 if any(row["errors"] for row in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
