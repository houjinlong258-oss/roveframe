"""Step 2 验证：SSE wire format 与 AgentSseEvent 契约的一致性。

**这是契约测试**：TS 侧 ``src/lib/agent/stream-events.ts`` 是唯一权威，
``src/hooks/use-sse.ts`` 的 ``KNOWN_EVENT_TYPES`` 是白名单。
本测试锁住「Python 侧产出的事件名一定在白名单内」这一事实 ——
否则事件会被前端**静默丢弃**（Step 1 报告缺陷 B1 同型问题）。

运行::

    python -m pytest roveagent/api/stream_wire_test.py -v
"""
from __future__ import annotations

import json
import unittest

from roveagent.api import stream_wire as sw

#: 与 src/hooks/use-sse.ts 的 KNOWN_EVENT_TYPES 逐字对应。
#: 改任何一个都必须同步另一侧 —— 本常量就是那条警戒线。
FRONTEND_KNOWN_EVENT_TYPES = frozenset({
    "status",
    "provider",
    "delta",
    "artifact",
    "notice",
    "error",
    "done",
    "approval",
    "runtime_status",
})

#: AgentSseEvent 中的 AgentStatusPhase 取值
FRONTEND_STATUS_PHASES = frozenset({
    "thinking",
    "analyzing",
    "calling_tool",
    "tool_done",
    "generating",
    "creating_file",
})


def _parse(line: str) -> dict:
    """把一行 SSE 解回 dict。"""
    assert line.startswith("data: "), f"not an SSE data line: {line!r}"
    assert line.endswith("\n\n"), f"SSE line must end with blank line: {line!r}"
    body = line[len("data: "):].strip()
    return json.loads(body)


class WireFormatTest(unittest.TestCase):
    def test_every_event_type_is_in_frontend_whitelist(self) -> None:
        """所有构造器产出的事件名必须在前端白名单内。"""
        lines = [
            sw.ev_runtime_status("roveagent", "agent=ceo"),
            sw.ev_status("thinking"),
            sw.ev_status("calling_tool", tool="read_file"),
            sw.ev_delta("hello"),
            sw.ev_notice("warning", "blocked", code="x"),
            sw.ev_error("boom", code="y"),
            sw.ev_done(),
        ]
        for line in lines:
            with self.subTest(line=line.strip()):
                payload = _parse(line)
                self.assertIn(
                    payload["type"], FRONTEND_KNOWN_EVENT_TYPES,
                    f"{payload['type']!r} 会被 use-sse.ts 静默丢弃",
                )

    def test_status_phases_are_valid(self) -> None:
        for phase in ("thinking", "analyzing", "calling_tool", "tool_done"):
            with self.subTest(phase=phase):
                payload = _parse(sw.ev_status(phase))
                self.assertIn(payload["phase"], FRONTEND_STATUS_PHASES)

    def test_delta_uses_text_field(self) -> None:
        """use-sse.ts 读 `parsed.text` —— 字段名写错就是静默空消息。"""
        payload = _parse(sw.ev_delta("abc"))
        self.assertEqual(payload["text"], "abc")

    def test_error_carries_error_field(self) -> None:
        """use-sse.ts 见到 `error` 字符串即判定为错误事件。"""
        payload = _parse(sw.ev_error("boom"))
        self.assertIsInstance(payload.get("error"), str)

    def test_runtime_status_modes(self) -> None:
        for mode in ("roveagent", "fallback", "unavailable"):
            with self.subTest(mode=mode):
                payload = _parse(sw.ev_runtime_status(mode))
                self.assertEqual(payload["type"], "runtime_status")
                self.assertEqual(payload["mode"], mode)

    def test_done_sentinel(self) -> None:
        self.assertEqual(sw.sse_done_sentinel(), "data: [DONE]\n\n")


class CallbackTranslationTest(unittest.TestCase):
    """``events_for_callback`` 对三类回调的翻译。"""

    def test_delta_callback(self) -> None:
        out = sw.events_for_callback({"kind": "delta", "text": "hi"})
        self.assertEqual(len(out), 1)
        self.assertEqual(_parse(out[0])["type"], "delta")

    def test_empty_delta_is_dropped(self) -> None:
        for payload in ({"kind": "delta", "text": ""},
                        {"kind": "delta", "text": None},
                        {"kind": "delta"}):
            with self.subTest(payload=payload):
                self.assertEqual(sw.events_for_callback(payload), [])

    def test_tool_started_maps_to_calling_tool(self) -> None:
        out = sw.events_for_callback({
            "kind": "tool", "event": "tool.started", "tool": "read_file",
        })
        self.assertEqual(len(out), 1)
        payload = _parse(out[0])
        self.assertEqual(payload["phase"], "calling_tool")
        self.assertEqual(payload["tool"], "read_file")

    def test_tool_completed_maps_to_tool_done(self) -> None:
        out = sw.events_for_callback({
            "kind": "tool", "event": "tool.completed", "tool": "read_file",
        })
        self.assertEqual(_parse(out[0])["phase"], "tool_done")

    def test_non_tool_progress_kinds_are_ignored(self) -> None:
        """`_thinking` / `reasoning.available` 等不是工具事件，必须忽略。"""
        for kind in ("_thinking", "reasoning.available", "", "tool.unknown"):
            with self.subTest(kind=kind):
                self.assertEqual(
                    sw.events_for_callback({"kind": "tool", "event": kind, "tool": "x"}),
                    [],
                )

    def test_status_callback_maps_to_analyzing(self) -> None:
        out = sw.events_for_callback({"kind": "status", "args": ["lifecycle", "msg"]})
        self.assertEqual(len(out), 1)
        payload = _parse(out[0])
        self.assertEqual(payload["phase"], "analyzing")
        self.assertEqual(payload["label"], "lifecycle")

    def test_unknown_callback_kind_yields_nothing(self) -> None:
        """未知回调不猜、不造事件名。"""
        for kind in ("mystery", None, ""):
            with self.subTest(kind=kind):
                self.assertEqual(sw.events_for_callback({"kind": kind}), [])


class GateNoticeTest(unittest.TestCase):
    """门控拦截结果 → notice 事件。"""

    def test_blocked_result_becomes_notice(self) -> None:
        blocked = json.dumps({
            "error": "enterprise_gate_blocked",
            "tool": "write_file",
            "requires_approval": False,
            "approval_policy": "manager",
            "reason": "permission denied: requires 'files:write'",
        })
        line = sw.gate_denied_notice(blocked)
        self.assertIsNotNone(line)
        payload = _parse(line)  # type: ignore[arg-type]
        self.assertEqual(payload["type"], "notice")
        self.assertEqual(payload["level"], "warning")
        self.assertIn("files:write", payload.get("technical", ""))

    def test_approval_result_becomes_info_notice(self) -> None:
        pending = json.dumps({
            "error": "enterprise_gate_blocked",
            "tool": "terminal",
            "requires_approval": True,
            "approval_policy": "manager",
            "reason": "",
        })
        payload = _parse(sw.gate_denied_notice(pending))  # type: ignore[arg-type]
        self.assertEqual(payload["level"], "info")
        self.assertEqual(payload["code"], "tool_requires_approval")

    def test_non_gate_result_is_ignored(self) -> None:
        for result in ("plain text", "{\"foo\": 1}", None, 42,
                       json.dumps({"error": "something_else"})):
            with self.subTest(result=result):
                self.assertIsNone(sw.gate_denied_notice(result))

    def test_malformed_json_is_ignored(self) -> None:
        self.assertIsNone(sw.gate_denied_notice("enterprise_gate_blocked {not json"))

    def test_tool_completion_with_gate_result_appends_notice(self) -> None:
        """被门控拦下的工具：既有 tool_done，也有 notice。"""
        blocked = json.dumps({
            "error": "enterprise_gate_blocked", "tool": "write_file",
            "requires_approval": False, "reason": "denied",
        })
        out = sw.events_for_callback({
            "kind": "tool", "event": "tool.completed",
            "tool": "write_file", "result": blocked,
        })
        self.assertEqual(len(out), 2)
        self.assertEqual(_parse(out[0])["phase"], "tool_done")
        self.assertEqual(_parse(out[1])["type"], "notice")


if __name__ == "__main__":
    unittest.main(verbosity=2)
