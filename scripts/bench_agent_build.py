#!/usr/bin/env python
"""agent_build benchmark — Phase 11 / Task 3, Step 1（先测量，后优化）。

背景
----
Phase 10.7 实测：单请求 P50 ≈ 5.44s，其中 ``AIAgent.__init__``（下称
agent_build）占 75.0%（≈4.08s）。但**4.08s 具体花在哪一行从未定位**——
审计报告的结论是 UNKNOWN，只有强假设（``get_tool_definitions`` 里的
registry walking + schema filtering + check_fn probing）。

Task 3 明令：禁止直接优化，第一步建立 benchmark。本脚本就是那一步。

它做三件事，全部只读：
  1. 直接测 ``AIAgent.__init__`` 的墙钟耗时（多轮，含预热）。
  2. 用定时包装器分别测各可疑子阶段的**调用次数 + 累计耗时**：
       - ``get_tool_definitions``（tool schema 生成）
       - ``ToolRegistry.get_definitions``（registry 遍历 / 过滤）
       - ``_check_fn_cached`` / ``_run_check_fn_uncached``（check_fn 探测）
       - ``resolve_toolsets_for_request``（capability resolve）
       - ``discover_plugins``（插件发现）
       - 记忆 / 会话加载
  3. 用 cProfile 给出累计耗时排名，避免只看被怀疑的对象。

用法
----
    python scripts/bench_agent_build.py                 # 默认 3 轮预热 + 9 轮测量
    python scripts/bench_agent_build.py --iters 20 --profile-iters 3
    python scripts/bench_agent_build.py --json out.json

不引入任何第三方依赖。默认强制离线（ROVEAGENT_OFFLINE=1），
不会向任何 provider 发起真实请求，也不产生计费。
"""
from __future__ import annotations

import argparse
import cProfile
import io
import json
import os
import pstats
import statistics
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# 与 scripts/run-python-tests.py 同样的离线保护：绝不允许真实外部消费。
os.environ.setdefault("ROVEAGENT_OFFLINE", "1")

# init_agent 只有在「显式 base_url + api_key」齐备时才走显式凭证分支；
# 缺任一项就落到 resolve_provider_client("auto")，在无 config.yaml 的本机
# 直接抛 "No LLM provider configured"。这里给出一个**环回** mock 端点占位，
# 与 scripts/_probe_gate_wiring.py 的做法一致。
# 注意：__init__ 期间不会发起任何 HTTP 请求（仅构造 client），
# 且 ROVEAGENT_OFFLINE=1 在 auxiliary_client 层有硬闸门。
_DEFAULT_MOCK_BASE_URL = "http://127.0.0.1:8799/v1"
os.environ.setdefault("ROVEAGENT_LLM_BASE_URL", _DEFAULT_MOCK_BASE_URL)
os.environ.setdefault("ROVEAGENT_LLM_API_KEY", "bench-offline-placeholder")
os.environ.setdefault("ROVEAGENT_LLM_MODEL", "gpt-4o-mini")
# 默认使用临时数据根：不污染仓库内 .roveagent，且跨机器可复现。
# 用 --root 指定真实根可复现生产现场（memory/session 数据量不同）。
if not os.environ.get("ROVEAGENT_ROOT"):
    import tempfile as _tempfile

    os.environ["ROVEAGENT_ROOT"] = _tempfile.mkdtemp(prefix="bench-agent-build-")


# ---------------------------------------------------------------------------
# 计时包装器
# ---------------------------------------------------------------------------
class Timer:
    """累计某个函数被调用的次数与总耗时（单调时钟）。"""

    def __init__(self, label: str) -> None:
        self.label = label
        self.calls = 0
        self.total = 0.0
        self.max = 0.0
        self.originals: list[tuple[Any, str, Any]] = []

    def wrap(self, obj: Any, attr: str, module_label: str = "") -> None:
        original = getattr(obj, attr, None)
        if original is None:
            return
        if getattr(original, "_bench_wrapped", False):
            return
        timer = self

        def wrapper(*args, **kwargs):
            start = time.perf_counter()
            try:
                return original(*args, **kwargs)
            finally:
                elapsed = time.perf_counter() - start
                timer.calls += 1
                timer.total += elapsed
                if elapsed > timer.max:
                    timer.max = elapsed

        wrapper._bench_wrapped = True  # type: ignore[attr-defined]
        wrapper._bench_original = original  # type: ignore[attr-defined]
        setattr(obj, attr, wrapper)
        self.originals.append((obj, attr, original))

    def restore(self) -> None:
        for obj, attr, original in self.originals:
            setattr(obj, attr, original)
        self.originals.clear()

    def reset(self) -> None:
        self.calls = 0
        self.total = 0.0
        self.max = 0.0

    def as_dict(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "calls": self.calls,
            "total_ms": round(self.total * 1000, 2),
            "max_ms": round(self.max * 1000, 2),
        }


def _install_timers() -> list[Timer]:
    timers: list[Timer] = []

    def mk(label: str) -> Timer:
        t = Timer(label)
        timers.append(t)
        return t

    # 1) tool schema 生成 —— agent_init.py:1613 经 _ra() 调用 runtime.get_tool_definitions
    t_defs = mk("get_tool_definitions (schema 生成)")
    try:
        from roveagent import runtime as _runtime

        t_defs.wrap(_runtime, "get_tool_definitions")
    except Exception as exc:  # pragma: no cover
        print(f"[bench] warn: cannot wrap runtime.get_tool_definitions: {exc}")

    # 2) registry 遍历 / 过滤
    t_reg = mk("ToolRegistry.get_definitions (registry 遍历)")
    try:
        from roveagent.tools.registry import ToolRegistry

        t_reg.wrap(ToolRegistry, "get_definitions")
    except Exception as exc:  # pragma: no cover
        print(f"[bench] warn: cannot wrap ToolRegistry.get_definitions: {exc}")

    # 3) check_fn 探测（含 TTL 缓存命中路径）
    t_check = mk("_check_fn_cached (check_fn 探测, 含缓存命中)")
    t_check_raw = mk("_run_check_fn_uncached (check_fn 真实探测)")
    try:
        from roveagent.tools import registry as _reg

        t_check.wrap(_reg, "_check_fn_cached")
        t_check_raw.wrap(_reg, "_run_check_fn_uncached")
    except Exception as exc:  # pragma: no cover
        print(f"[bench] warn: cannot wrap check_fn helpers: {exc}")

    # 4) capability resolve
    t_cap = mk("resolve_toolsets_for_request (capability resolve)")
    try:
        from roveagent.api import toolsets as _toolsets

        for name in ("resolve_toolsets_for_request", "resolve_toolsets", "resolve_max_iterations"):
            t_cap.wrap(_toolsets, name)
    except Exception as exc:  # pragma: no cover
        print(f"[bench] warn: cannot wrap toolsets resolver: {exc}")

    # 5) 插件发现
    t_plugin = mk("discover_plugins (插件发现)")
    try:
        from roveagent.core import agent_init as _ai

        t_plugin.wrap(_ai, "discover_plugins")
    except Exception as exc:  # pragma: no cover
        print(f"[bench] warn: cannot wrap discover_plugins: {exc}")

    # 6) 记忆加载
    t_mem = mk("memory 加载")
    try:
        from roveagent.core import agent_init as _ai2

        for name in ("_load_memories", "load_memories"):
            t_mem.wrap(_ai2, name)
    except Exception:  # pragma: no cover
        pass

    # 7) SSL CA 校验（H1 假设：每次 init 都重新解析 CA bundle）
    t_ssl = mk("ssl_guard.verify_ca_bundle (CA 校验)")
    t_ssl_path = mk("ssl_guard._validate_bundle_path (单个 bundle 解析)")
    try:
        from roveagent.core import ssl_guard as _ssl

        t_ssl.wrap(_ssl, "verify_ca_bundle")
        t_ssl_path.wrap(_ssl, "_validate_bundle_path")
    except Exception as exc:  # pragma: no cover
        print(f"[bench] warn: cannot wrap ssl_guard: {exc}")

    # 8) 本地模型上下文长度探测（H2 假设：对 loopback 端点做真实 HTTP 探测）
    t_ctx = mk("model_metadata._query_local_context_length (本地端点探测)")
    t_ctx_raw = mk("  .._query_local_context_length_uncached (真实探测)")
    t_detect = mk("  ..model_metadata.detect_local_server_type")
    t_ollama = mk("  ..model_metadata._query_ollama_api_show")
    try:
        from roveagent.core import model_metadata as _mm

        t_ctx.wrap(_mm, "_query_local_context_length")
        t_ctx_raw.wrap(_mm, "_query_local_context_length_uncached")
        t_detect.wrap(_mm, "detect_local_server_type")
        t_ollama.wrap(_mm, "_query_ollama_api_show")
    except Exception as exc:  # pragma: no cover
        print(f"[bench] warn: cannot wrap model_metadata: {exc}")

    return timers


def _build_agent_once(iteration: int):
    """构造一个 AIAgent —— 参数镜像 roveagent/api/app.py::_build_agent。"""
    from roveagent.runtime import AIAgent

    return AIAgent(
        base_url=os.environ.get("ROVEAGENT_LLM_BASE_URL") or None,
        api_key=os.environ.get("ROVEAGENT_LLM_API_KEY") or "bench-dummy-key",
        model=os.environ.get("ROVEAGENT_LLM_MODEL", "gpt-4o-mini"),
        enabled_toolsets=["safe", "memory"],
        max_iterations=8,
        quiet_mode=True,
        ephemeral_system_prompt="You are a benchmark harness.",
        prefill_messages=None,
        stream_delta_callback=None,
        tool_progress_callback=None,
        status_callback=None,
        session_id=f"bench-agent-build-{os.getpid()}-{iteration}",
    )


def _describe(name: str, value: Any) -> str | None:
    """把单个 percent 统计值格式化为一行。"""
    return f"  {value:9.2f}ms  {name}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Benchmark AIAgent.__init__ (agent_build)")
    parser.add_argument("--iters", type=int, default=9, help="测量轮数（默认 9）")
    parser.add_argument("--warmup", type=int, default=3, help="预热轮数（默认 3）")
    parser.add_argument("--profile-iters", type=int, default=3, help="cProfile 采样轮数（默认 3）")
    parser.add_argument("--top", type=int, default=25, help="cProfile 输出条数")
    parser.add_argument("--json", type=str, default="", help="把结果写到 JSON 文件")
    args = parser.parse_args(argv)

    print("=" * 78)
    print("agent_build benchmark — Phase 11 / Task 3 Step 1")
    print("=" * 78)
    print(f"python      : {sys.version.split()[0]}")
    print(f"ROVEAGENT_OFFLINE   : {os.environ.get('ROVEAGENT_OFFLINE')}")
    print(f"ROVEAGENT_ROOT      : {os.environ.get('ROVEAGENT_ROOT')}")
    print(f"LLM base_url        : {os.environ.get('ROVEAGENT_LLM_BASE_URL')} (mock, 环回)")
    print(f"warmup/measure/prof : {args.warmup} / {args.iters} / {args.profile_iters}")
    print()

    result: dict[str, Any] = {"env": {
        "python": sys.version.split()[0],
        "offline": os.environ.get("ROVEAGENT_OFFLINE"),
    }}

    # -----------------------------------------------------------------
    # 阶段 0：导入图成本（只付一次，但要知道多大）
    # -----------------------------------------------------------------
    t_import = time.perf_counter()
    import roveagent.runtime  # noqa: F401
    import_cost = time.perf_counter() - t_import
    print(f"[0] import roveagent.runtime (冷)      : {import_cost * 1000:9.2f} ms")
    result["import_runtime_ms"] = round(import_cost * 1000, 2)

    timers = _install_timers()

    # -----------------------------------------------------------------
    # 阶段 1：总耗时（warmup + measure）
    # -----------------------------------------------------------------
    warm_times: list[float] = []
    for i in range(args.warmup):
        t0 = time.perf_counter()
        try:
            _build_agent_once(1000 + i)
        except Exception as exc:
            print(f"\n[FATAL] AIAgent.__init__ 预热失败: {type(exc).__name__}: {exc}")
            import traceback

            traceback.print_exc()
            return 2
        warm_times.append(time.perf_counter() - t0)

    for t in timers:
        t.reset()

    times: list[float] = []
    for i in range(args.iters):
        t0 = time.perf_counter()
        _build_agent_once(i)
        times.append(time.perf_counter() - t0)

    ms = [t * 1000 for t in times]
    print()
    print(f"[1] AIAgent.__init__ 墙钟耗时 (n={len(ms)})")
    print(f"    min={min(ms):8.2f}ms  p50={statistics.median(ms):8.2f}ms  "
          f"mean={statistics.fmean(ms):8.2f}ms  max={max(ms):8.2f}ms")
    print(f"    预热首轮={warm_times[0] * 1000:8.2f}ms  "
          f"预热末轮={warm_times[-1] * 1000:8.2f}ms")
    result["agent_build_ms"] = {
        "iterations": len(ms),
        "min": round(min(ms), 2),
        "p50": round(statistics.median(ms), 2),
        "mean": round(statistics.fmean(ms), 2),
        "max": round(max(ms), 2),
        "all": [round(x, 2) for x in ms],
    }
    result["warmup_first_ms"] = round(warm_times[0] * 1000, 2)

    # -----------------------------------------------------------------
    # 阶段 2：子阶段归因（上面的测量轮内累积）
    # -----------------------------------------------------------------
    print()
    print(f"[2] 子阶段归因（上面 {args.iters} 轮内的累计 / 调用次数）")
    print(f"    {'阶段':<52}{'累计ms':>10}{'次数':>8}{'单次max':>10}")
    attribution = []
    total_wall = sum(times) * 1000
    for t in timers:
        d = t.as_dict()
        if d["calls"] == 0:
            continue
        per_call = d["total_ms"] / d["calls"] if d["calls"] else 0.0
        print(f"    {d['label']:<52}{d['total_ms']:>10.2f}{d['calls']:>8}{d['max_ms']:>10.2f}")
        attribution.append({
            **d,
            "per_call_ms": round(per_call, 3),
            "pct_of_wall": round(d["total_ms"] / total_wall * 100, 1) if total_wall else 0.0,
        })
    result["attribution"] = attribution
    result["total_wall_ms"] = round(total_wall, 2)

    for t in timers:
        t.restore()

    # -----------------------------------------------------------------
    # 阶段 3：cProfile（不猜，看真实累计排名）
    # -----------------------------------------------------------------
    print()
    print(f"[3] cProfile 累计耗时排名（n={args.profile_iters} 轮，cutoff 输出前 {args.top} 条）")
    profiler = cProfile.Profile()
    profiler.enable()
    for i in range(args.profile_iters):
        _build_agent_once(5000 + i)
    profiler.disable()

    stream = io.StringIO()
    stats = pstats.Stats(profiler, stream=stream)
    stats.sort_stats("cumulative")
    stats.print_stats(args.top)
    text = stream.getvalue()
    print(text)

    # 提取 cumtime 排名（可解析部分）
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split(None, 5)
        if len(parts) == 6 and parts[0].isdigit() and parts[1].isdigit():
            try:
                rows.append({
                    "ncalls": int(parts[0]),
                    "tottime_ms": round(float(parts[2]) * 1000, 2),
                    "cumtime_ms": round(float(parts[3]) * 1000, 2),
                    "func": parts[5].strip(),
                })
            except ValueError:
                continue
    result["cprofile_top"] = rows
    result["cprofile_raw"] = text

    if args.json:
        out = Path(args.json)
        if not out.is_absolute():
            out = REPO_ROOT / out
        out.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\n[bench] JSON 结果写入 {out}")

    print("=" * 78)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
