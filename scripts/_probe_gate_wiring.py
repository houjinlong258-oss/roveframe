"""只读探针：验证 AIAgent 的工具循环是否真的经过 EnterpriseToolGate。

背景
----
`/api/agent/chat` 走 `AIAgent.chat()` 执行了一次 read_file，
但 `.roveagent/audit/tool_gate.jsonl` 没有产生任何记录。
而 `install_enterprise_gate()` 报告中间件已注册（`gate installed: True`）。

本探针区分三种可能：
  (a) 中间件根本没被调用          → 门控未生效（严重）
  (b) 中间件被调用但审计未落盘      → 审计 sink 失效（严重）
  (c) 中间件被调用且审计落盘        → 之前只是路径/时机问题

做法：在 gate 的真实审计 sink 外面包一层 spy，再让 Agent 跑一次工具调用。
不修改任何仓库文件。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))

TMP = Path(tempfile.mkdtemp(prefix="gate-probe-"))
os.environ["ROVEAGENT_ROOT"] = str(TMP)
os.environ["ROVEAGENT_API_KEY"] = "probe-key"
os.environ["ROVEAGENT_LLM_BASE_URL"] = os.environ.get(
    "ROVEAGENT_LLM_BASE_URL", "http://127.0.0.1:8799/v1")
os.environ["ROVEAGENT_LLM_API_KEY"] = os.environ.get("ROVEAGENT_LLM_API_KEY", "mock-test-key")

spy: list[dict] = []


def main() -> int:
    from roveagent.enterprise.gate_hook import get_gate, install_enterprise_gate
    from roveagent.tools.framework import ToolContext
    from roveagent.enterprise.run_context import bind_tool_context

    # 装 gate，并把它的审计 sink 换成 spy（同时保留原 sink 行为）
    gate = install_enterprise_gate()
    original_sink = gate._audit_sink

    def spy_sink(event: dict) -> None:
        spy.append(event)
        print("[spy] gate audit event:", json.dumps(
            {k: event.get(k) for k in
             ("tool", "allowed", "requires_approval", "risk", "reason")},
            ensure_ascii=False))
        if original_sink is not None:
            try:
                original_sink(event)
            except Exception as exc:  # noqa: BLE001
                print("[spy] original sink raised:", exc)

    gate._audit_sink = spy_sink

    print(f"[probe] ROVEAGENT_ROOT={TMP}")
    print(f"[probe] LLM base_url={os.environ['ROVEAGENT_LLM_BASE_URL']}")

    # 直接先验一次 authorize()，确认 gate 本身工作正常
    direct = gate.authorize(
        ToolContext(tenant_id="t", business_id="b", user_id="u", role="owner",
                    permissions=frozenset({"files:read"}), request_id="r", task_id="k",
                    agent_id="developer"),
        "read_file", {"path": "README.md"})
    print(f"[probe] direct authorize -> allowed={direct.allowed} "
          f"approval={direct.requires_approval} reason={direct.reason}")
    direct_events = len(spy)
    print(f"[probe] spy events after direct call: {direct_events}")

    # 现在跑真实的 Agent 工具循环
    from roveagent.runtime import AIAgent
    agent = AIAgent(
        base_url=os.environ["ROVEAGENT_LLM_BASE_URL"],
        api_key=os.environ["ROVEAGENT_LLM_API_KEY"],
        model="mock-model",
        enabled_toolsets=["file", "terminal"],
        max_iterations=4,
        quiet_mode=True,
        ephemeral_system_prompt="You are a test agent. Use tools when asked.",
    )
    print("[probe] running AIAgent.chat('please read the README file') ...")
    reply = agent.chat("please read the README file")
    print(f"[probe] reply={reply[:200]!r}")

    loop_events = len(spy) - direct_events
    print(f"\n[probe] gate events during Agent loop: {loop_events}")

    tool_gate_log = TMP / "audit" / "tool_gate.jsonl"
    print(f"[probe] tool_gate.jsonl exists: {tool_gate_log.exists()}")
    if tool_gate_log.exists():
        print(f"[probe] entries: {len(tool_gate_log.read_text(encoding='utf-8').splitlines())}")

    print("\n[verdict]", end=" ")
    if loop_events == 0:
        print("(a) 中间件未在 Agent 工具循环中被调用 —— 门控未生效")
        return 2
    if not tool_gate_log.exists():
        print("(b) 中间件被调用但审计未落盘 —— sink 失效")
        return 3
    print("(c) 中间件被调用且审计落盘 —— 门控生效")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
