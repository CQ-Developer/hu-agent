"""指标注册表与 /metrics 端点测试。"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from huagent.api.app import create_app
from huagent.common.config import get_settings
from huagent.common.metrics import Counter, Gauge, Histogram, Registry


def test_counter_gauge_render() -> None:
    registry = Registry()
    counter = registry.counter("demo_requests_total", "请求数", ("method", "status"))
    counter.inc(method="GET", status="200")
    counter.inc(2, method="GET", status="200")
    counter.inc(method="POST", status="500")
    gauge = registry.gauge("demo_pending", "待处理")
    gauge.set(7)

    rendered = registry.render()
    assert "# TYPE demo_requests_total counter" in rendered
    assert 'demo_requests_total{method="GET",status="200"} 3' in rendered
    assert 'demo_requests_total{method="POST",status="500"} 1' in rendered
    assert "# TYPE demo_pending gauge" in rendered
    assert "demo_pending 7" in rendered


def test_histogram_buckets_and_escaping() -> None:
    histogram = Histogram("demo_latency_seconds", "耗时", ("path",))
    histogram.observe(0.004, path="/a")
    histogram.observe(0.3, path="/a")
    histogram.observe(2.0, path="/a")
    rendered = "\n".join(histogram.render())

    # 累计桶：0.005 → 1、0.5 → 2、+Inf → 3
    assert 'demo_latency_seconds_bucket{path="/a",le="0.005"} 1' in rendered
    assert 'demo_latency_seconds_bucket{path="/a",le="0.5"} 2' in rendered
    assert 'demo_latency_seconds_bucket{path="/a",le="+Inf"} 3' in rendered
    assert 'demo_latency_seconds_count{path="/a"} 3' in rendered
    assert histogram.count(path="/a") == 3

    quoted = Counter("demo_quoted_total", "转义", ("label",))
    quoted.inc(label='a"b\\c')
    assert 'demo_quoted_total{label="a\\"b\\\\c"} 1' in "\n".join(quoted.render())


def test_label_mismatch_rejected() -> None:
    counter = Counter("demo_strict_total", "严格标签", ("result",))
    with pytest.raises(ValueError, match="标签不匹配"):
        counter.inc(value="ok")


def test_gauge_clear_removes_samples() -> None:
    gauge = Gauge("demo_transient", "瞬时", ("metric",))
    gauge.set(1, metric="a")
    gauge.clear()
    assert gauge.value(metric="a") is None
    assert not [line for line in gauge.render() if line.startswith("demo_transient")]


def _client(**env: str) -> TestClient:
    get_settings.cache_clear()
    with pytest.MonkeyPatch.context() as monkey:
        for key, value in env.items():
            monkey.setenv(key, value)
        get_settings.cache_clear()
        return TestClient(create_app())


def test_metrics_requires_token_when_configured() -> None:
    client = _client(HUAGENT_METRICS_TOKEN="s3cret-token", HUAGENT_SCHEMA_CHECK_ENABLED="false")
    try:
        assert client.get("/api/v1/system/metrics").status_code == 401
        ok = client.get("/api/v1/system/metrics", headers={"authorization": "Bearer s3cret-token"})
        core = client.get("/api/v1/system/metrics", headers={"authorization": "Bearer s3cret-token"})
        assert core.status_code == 200
        assert "huagent_http_requests_total" in core.text
        assert ok.status_code == 200
    finally:
        get_settings.cache_clear()


def test_metrics_can_be_disabled() -> None:
    client = _client(HUAGENT_METRICS_ENABLED="false", HUAGENT_SCHEMA_CHECK_ENABLED="false")
    try:
        assert client.get("/api/v1/system/metrics").status_code == 404
    finally:
        get_settings.cache_clear()


def test_http_metrics_recorded_for_unmatched_route() -> None:
    client = _client(HUAGENT_SCHEMA_CHECK_ENABLED="false", HUAGENT_METRICS_TOKEN="t")
    try:
        client.get("/api/v1/definitely-not-here")
        text = client.get("/api/v1/system/metrics", headers={"authorization": "Bearer t"}).text
        assert 'huagent_http_requests_total{method="GET",path="unmatched",status="404"}' in text
        # 指标端点自身不计数
        assert 'path="/api/v1/system/metrics"' not in text
    finally:
        get_settings.cache_clear()


def test_db_collection_failure_is_degraded_not_fatal() -> None:
    """数据库不可用时仍返回进程内指标，并累加采集错误计数。"""
    client = _client(
        HUAGENT_SCHEMA_CHECK_ENABLED="false",
        HUAGENT_METRICS_TOKEN="t",
        HUAGENT_DATABASE_URL="postgresql+psycopg://nobody:nobody@127.0.0.1:1/none",
    )
    try:
        response = client.get("/api/v1/system/metrics", headers={"authorization": "Bearer t"})
        assert response.status_code == 200
        assert "huagent_http_requests_total" in response.text
        assert "huagent_metrics_collect_errors_total" in response.text
    finally:
        get_settings.cache_clear()
