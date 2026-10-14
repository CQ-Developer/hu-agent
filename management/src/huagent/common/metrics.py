"""极简 Prometheus 指标注册表（仅标准库，暴露文本格式 0.0.4）。

设计取舍：只实现 Counter / Gauge / Histogram 三种类型与固定标签集，
避免为了几个指标引入 prometheus_client；标签基数靠调用方使用「路由模板」而非原始路径约束。
"""

from __future__ import annotations

import threading
from collections.abc import Iterable

DEFAULT_BUCKETS: tuple[float, ...] = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)

Labels = tuple[tuple[str, str], ...]


def _escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _labels_key(labels: dict[str, str]) -> Labels:
    return tuple(sorted((str(key), str(value)) for key, value in labels.items()))


def _render_labels(labels: Labels, extra: tuple[str, str] | None = None) -> str:
    items = list(labels)
    if extra is not None:
        items.append(extra)
    if not items:
        return ""
    body = ",".join(f'{key}="{_escape(value)}"' for key, value in items)
    return "{" + body + "}"


class _Metric:
    kind = "untyped"

    def __init__(self, name: str, help_text: str, label_names: tuple[str, ...]) -> None:
        self.name = name
        self.help = help_text
        self.label_names = label_names

    def _check(self, labels: dict[str, str]) -> Labels:
        if set(labels) != set(self.label_names):
            raise ValueError(f"{self.name} 标签不匹配：期望 {self.label_names}，实际 {sorted(labels)}")
        return _labels_key(labels)

    def render(self) -> Iterable[str]:
        """输出 Prometheus 文本格式的若干行（各子类实现）。"""
        raise NotImplementedError


class Counter(_Metric):
    kind = "counter"

    def __init__(self, name: str, help_text: str, label_names: tuple[str, ...] = ()) -> None:
        super().__init__(name, help_text, label_names)
        self._values: dict[Labels, float] = {}

    def inc(self, amount: float = 1.0, **labels: str) -> None:
        key = self._check(labels)
        self._values[key] = self._values.get(key, 0.0) + amount

    def value(self, **labels: str) -> float:
        return self._values.get(self._check(labels), 0.0)

    def render(self) -> Iterable[str]:
        yield f"# HELP {self.name} {self.help}"
        yield f"# TYPE {self.name} counter"
        for key, value in sorted(self._values.items()):
            yield f"{self.name}{_render_labels(key)} {value:g}"


class Gauge(_Metric):
    kind = "gauge"

    def __init__(self, name: str, help_text: str, label_names: tuple[str, ...] = ()) -> None:
        super().__init__(name, help_text, label_names)
        self._values: dict[Labels, float] = {}

    def set(self, value: float, **labels: str) -> None:
        self._values[self._check(labels)] = float(value)

    def value(self, **labels: str) -> float | None:
        return self._values.get(self._check(labels))

    def clear(self) -> None:
        """重新采集前清空（用于「当前状态」类指标，避免陈旧样本）。"""
        self._values.clear()

    def render(self) -> Iterable[str]:
        yield f"# HELP {self.name} {self.help}"
        yield f"# TYPE {self.name} gauge"
        for key, value in sorted(self._values.items()):
            yield f"{self.name}{_render_labels(key)} {value:g}"


class Histogram(_Metric):
    kind = "histogram"

    def __init__(
        self,
        name: str,
        help_text: str,
        label_names: tuple[str, ...] = (),
        buckets: tuple[float, ...] = DEFAULT_BUCKETS,
    ) -> None:
        super().__init__(name, help_text, label_names)
        self.buckets = tuple(sorted(buckets))
        self._counts: dict[Labels, list[int]] = {}
        self._sums: dict[Labels, float] = {}
        self._totals: dict[Labels, int] = {}

    def observe(self, value: float, **labels: str) -> None:
        key = self._check(labels)
        self._counts.setdefault(key, [0] * len(self.buckets))
        bucket_counts = self._counts[key]
        for index, upper in enumerate(self.buckets):
            if value <= upper:
                bucket_counts[index] += 1
        self._sums[key] = self._sums.get(key, 0.0) + value
        self._totals[key] = self._totals.get(key, 0) + 1

    def count(self, **labels: str) -> int:
        return self._totals.get(self._check(labels), 0)

    def render(self) -> Iterable[str]:
        yield f"# HELP {self.name} {self.help}"
        yield f"# TYPE {self.name} histogram"
        for key in sorted(set(self._counts) | set(self._totals)):
            bucket_counts = self._counts.get(key, [0] * len(self.buckets))
            for upper, count in zip(self.buckets, bucket_counts, strict=True):
                yield f"{self.name}_bucket{_render_labels(key, ('le', f'{upper:g}'))} {count}"
            yield f"{self.name}_bucket{_render_labels(key, ('le', '+Inf'))} {self._totals.get(key, 0)}"
            yield f"{self.name}_sum{_render_labels(key)} {self._sums.get(key, 0.0):g}"
            yield f"{self.name}_count{_render_labels(key)} {self._totals.get(key, 0)}"


class Registry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._metrics: dict[str, _Metric] = {}

    def _get[T: _Metric](
        self,
        factory: type[T],
        name: str,
        help_text: str,
        label_names: tuple[str, ...],
        **kwargs: object,
    ) -> T:
        with self._lock:
            metric = self._metrics.get(name)
            if metric is None:
                metric = factory(name, help_text, label_names, **kwargs)
                self._metrics[name] = metric
            if metric.label_names != label_names:
                raise ValueError(f"{name} 标签集不一致")
            return metric  # type: ignore[return-value]

    def counter(self, name: str, help_text: str, label_names: tuple[str, ...] = ()) -> Counter:
        return self._get(Counter, name, help_text, label_names)

    def gauge(self, name: str, help_text: str, label_names: tuple[str, ...] = ()) -> Gauge:
        return self._get(Gauge, name, help_text, label_names)

    def histogram(
        self,
        name: str,
        help_text: str,
        label_names: tuple[str, ...] = (),
        buckets: tuple[float, ...] = DEFAULT_BUCKETS,
    ) -> Histogram:
        return self._get(Histogram, name, help_text, label_names, buckets=buckets)

    def render(self) -> str:
        lines: list[str] = []
        for name in sorted(self._metrics):
            lines.extend(self._metrics[name].render())
        return "\n".join(lines) + "\n"


REGISTRY = Registry()

# HTTP 层（api/middleware.py 记录）
HTTP_REQUESTS = REGISTRY.counter(
    "huagent_http_requests_total", "HTTP 请求数（按路由模板与状态码）", ("method", "path", "status")
)
HTTP_DURATION = REGISTRY.histogram(
    "huagent_http_request_duration_seconds", "HTTP 请求耗时", ("method", "path")
)
# 业务层
USAGE_EVENTS = REGISTRY.counter(
    "huagent_usage_events_total", "用量事件处理结果（accepted/duplicated/rejected）", ("result",)
)
LOGIN_ATTEMPTS = REGISTRY.counter(
    "huagent_login_attempts_total", "登录尝试结果（success/failure/locked）", ("result",)
)
# 采集时从数据库读取（api/routes/system.py）
BUILD_INFO = REGISTRY.gauge("huagent_build_info", "构建与 schema 版本信息", ("version", "schema_version"))
DB_GAUGE = REGISTRY.gauge("huagent_db_gauge", "数据库即时状态量", ("metric",))
JOB_STATUS = REGISTRY.gauge("huagent_job_last_status", "worker 任务最近一次状态=1", ("job_id", "status"))
JOB_TIMESTAMP = REGISTRY.gauge(
    "huagent_job_last_timestamp_seconds", "worker 任务最近开始/结束时间戳", ("job_id", "phase")
)
