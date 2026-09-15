"""只读探针 v3：工具执行的线程身份 + tool context 解析结果。

v2 为什么看不到调用：`install_enterprise_gate()` 才注册中间件，
v2 没调用它，所以中间件压根没进执行链。

v3 修正：先 `install_enterprise_gate()`，再替换 `gate_hook._resolve_context`。
"""
from __future__ import annotations

import os
import sys
import tempfile
import threading
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

TMP = Path(tempfile.mkdtemp(prefix="ctx-probe3-"))
os.environ["ROVEAGENT_ROOT"] = str(TMP)
os.environ["ROVEAGENT_API_KEY"] = "probe-key"
os.environ["ROVEAGENT_LLM_BASE_URL"] = os.environ.get(
    "ROVEAGENT_LLM_BASE_URL", "http://127.0.0.1:8799/v1")
os.environ["ROVEAGENT_LLM_API_KEY"] = os.environ.get("ROVEAGENT_LLM_API_KEY", "mock-test-key")

main_thread = threading.current_thread().name
observed: list[tuple[str, bool, str]] = []


def main() -> int:
    from roveagent.tools.framework import ToolContext
    from roveagent.enterprise.run_context import bind_tool_context
    import roveagent.enterprise.gate_hook as gh

    # 1) 先注册中间件（关键修正）
    gh.install_enterprise_gate()
    print("[probe] enterprise gate installed")

    # 2) 再替换中间件真正调用的那个名字
    real_resolve = gh._resolve_context

    def spying_resolve():
        ctx = real_resolve()
        filled = bool(getattr(ctx, "tenant_id", ""))
        observed.append((threading.current_thread().name, filled,
                         getattr(ctx, "agent_id", "") or ""))
        return ctx

    gh._resolve_context = spying_resolve

    ctx = ToolContext(
        tenant_id="tenant-1", business_id="biz-1", user_id="user-1",
        role="owner", permissions=frozenset({"files:read", "analytics:read"}),
        request_id="req-1", task_id="task-1", agent_id="developer",
    )

    with bind_tool_context(ctx):
        from roveagent.runtime import AIAgent
        agent = AIAgent(
            base_url=os.environ["ROVEAGENT_LLM_BASE_URL"],
            api_key=os.environ["ROVEAGENT_LLM_API_KEY"],
            model="mock-model",
            enabled_toolsets=["file"],
            max_iterations=3,
            quiet_mode=True,
        )
        print(f"[probe] caller thread = {main_thread!r}")
        reply = agent.chat("please read the README file")
        print(f"[probe] reply={reply[:140]!r}")

    print(f"\n[probe] _resolve_context invocations: {len(observed)}")
    for thread_name, filled, agent_id in observed:
        same = "SAME" if thread_name == main_thread else "DIFFERENT"
        print(f"  thread={thread_name!r:26s} {same:9s} filled={filled} agent_id={agent_id!r}")

    if not observed:
        print("\n[verdict] 中间件仍未调用 —— 工具执行未经过门控")
        return 1

    different = [o for o in observed if o[0] != main_thread]
    misses = [o for o in observed if not o[1]]
    print()
    if different and misses:
        print(f"[verdict] 确认：工具在【不同线程】({different[0][0]!r})执行，"
              "且 contextvar 未随线程传递")
        return 2
    if different:
        print("[verdict] 不同线程执行，但 context 已正确传递")
        return 4
    if misses:
        print("[verdict] 同线程但 context 为空 —— 绑定作用域没覆盖工具执行")
        return 3
    print("[verdict] context 正常传递，门控生效")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
