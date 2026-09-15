"""Mock LLM Provider —— 仅测试用（ROVEAGENT_TEST_MODE=true）。

用途
----
在没有生产模型密钥的前提下，验证完整链路：

    TS  →  Python RoveAgent Runtime  →  AIAgent 工具循环
        →  EnterpriseToolGate  →  Mock LLM  →  SSE  →  use-sse.ts

设计约束
--------
1. **只依赖标准库**（``http.server`` / ``json`` / ``threading``），
   不引入任何第三方包，不修改 ``pyproject.toml``。
2. **协议必须是真的 OpenAI 兼容**：内核走
   ``chat_completion_helpers.interruptible_streaming_api_call``（``stream=True``），
   因此这里必须返回合规的增量 JSON，否则内核解析失败。
3. **必须能触发真实工具调用**：只有让内核真的发起一次工具调用，
   ``EnterpriseToolGate`` 才会被走到，链路才算验证过。
   因此对特定提示词先返回 ``tool_calls``，下一轮再返回终稿。
4. **生产不启用**：仅当 ``ROVEAGENT_TEST_MODE=true`` 时由
   ``scripts/roveagent-service.sh`` 拉起。

端点
----
    GET  /v1/models                 探测用（部分客户端启动时会拉）
    POST /v1/chat/completions       支持 stream=true / false

行为矩阵（按最后一条 user 消息判定，确定性、可复现）
---------------------------------------------------
    "tool" 或 "read" 且尚无 tool 结果  → 第一轮：tool_calls(read_file)
    已有 tool 结果                     → 第二轮：文本终稿（逐 token）
    其他                               → 直接文本终稿（逐 token）
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Iterator

DEFAULT_PORT = 8799
MODEL_NAME = os.environ.get("ROVEAGENT_MOCK_MODEL", "mock-model")

# 逐 token 流式的分片大小（字符）。故意小一些，便于前端肉眼确认是流式。
CHUNK_CHARS = 6


def _sse(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def _chunk(completion_id: str, created: int, delta: dict[str, Any],
           finish_reason: str | None = None) -> dict[str, Any]:
    return {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": MODEL_NAME,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def _text_pieces(text: str) -> Iterator[str]:
    for i in range(0, len(text), CHUNK_CHARS):
        yield text[i:i + CHUNK_CHARS]


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                return content
            if isinstance(content, list):  # 多模态分段
                return " ".join(
                    part.get("text", "") for part in content
                    if isinstance(part, dict) and part.get("type") == "text"
                )
    return ""


def _has_tool_result(messages: list[dict[str, Any]]) -> bool:
    return any(m.get("role") == "tool" for m in messages)


def _tools_already_called(messages: list[dict[str, Any]]) -> set[str]:
    """扫描历史里 assistant 已发起过的工具名（避免重复调用同一工具）。"""
    called: set[str] = set()
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for call in (message.get("tool_calls") or []):
            fn = (call or {}).get("function") or {}
            name = fn.get("name")
            if isinstance(name, str):
                called.add(name)
    return called


#: 关键词 → (工具名, 参数构造)。**按顺序匹配，先命中先用。**
#:
#: 这套规则让 Mock 能驱动 Phase 2b 的真实执行闭环：
#: 读 → 写 → 打补丁 → 跑测试 → 提交（每一步都产生真实副作用）。
_TOOL_PLAYBOOK: tuple[tuple[tuple[str, ...], str], ...] = (
    (("write_file", "create file", "write a file", "新建文件", "写文件"), "write_file"),
    (("patch", "edit file", "modify file", "改文件", "修改文件"), "patch"),
    (("run test", "run the test", "pytest", "跑测试", "运行测试"), "terminal"),
    # Phase 2c：只读运维意图 → terminal。破坏性意图（kill/restart）刻意**不加**
    # 短关键词，避免误命中；测试用「restart service」这类明确表述经 run test 之外
    # 的路径触发 —— 见 devops 用例里显式使用 "restart the service"。
    (("process list", "process", "进程", "ps aux", "tasklist"), "terminal"),
    (("docker", "container", "容器"), "terminal"),
    (("disk", "磁盘", "df -h"), "terminal"),
    (("memory", "内存"), "terminal"),
    (("cpu", "load average", "负载"), "terminal"),
    (("service status", "服务状态", "systemctl status", "sc query"), "terminal"),
    (("logs", "log ", "日志", "journalctl"), "terminal"),
    (("restart the service", "restart service", "重启服务", "重启服务"), "terminal"),
    (("git commit", "commit", "提交"), "terminal"),
    (("search_files", "search code", "grep", "搜索代码"), "search_files"),
    (("read", "readme", "读取"), "read_file"),
)


def _pick_tool(user_text: str, already: set[str]) -> str | None:
    lowered = user_text.lower()
    for keywords, tool in _TOOL_PLAYBOOK:
        if tool in already:
            continue
        if any(k in lowered for k in keywords):
            return tool
    return None


def _build_arguments(tool: str, user_text: str) -> dict[str, Any]:
    """给每个工具生成确定性参数（便于测试断言）。"""
    sandbox = os.environ.get("ROVEAGENT_MOCK_SANDBOX_DIR", "").strip()
    if tool == "read_file":
        return {"path": os.environ.get("ROVEAGENT_MOCK_READ_PATH", "README.md")}
    if tool == "search_files":
        return {"query": os.environ.get("ROVEAGENT_MOCK_SEARCH_QUERY", "def ")}
    if tool == "write_file":
        target = os.environ.get("ROVEAGENT_MOCK_WRITE_PATH") or (
            f"{sandbox}/mock_created.txt" if sandbox else "mock_created.txt"
        )
        return {
            "path": target,
            "content": "# written by mock LLM\nvalue = 42\n",
        }
    if tool == "patch":
        return {
            "path": os.environ.get("ROVEAGENT_MOCK_PATCH_PATH") or (
                f"{sandbox}/mock_created.txt" if sandbox else "mock_created.txt"
            ),
            "old_string": "value = 42",
            "new_string": "value = 43",
        }
    if tool == "terminal":
        lowered = user_text.lower()
        # Phase 2c：按意图生成命令。**破坏性命令也如实生成** ——
        # 安全性由 EnterpriseToolGate 依据权限点判定，Mock 不自行拦截，
        # 否则就测不到门控（测的会变成 Mock 的逻辑）。
        # 顺序敏感：破坏性意图必须先于 status/logs 等宽松关键词。
        if "kill" in lowered or "杀掉" in user_text or "终止" in user_text:
            command = "taskkill /PID 1234 /F"
        elif "restart" in lowered or "重启" in user_text:
            command = "sc stop mock-service && sc start mock-service"
        elif "stop " in lowered or "停止" in user_text:
            command = "sc stop mock-service"
        elif "deploy" in lowered or "部署" in user_text:
            command = "docker compose up -d"
        elif "delete" in lowered or "删除" in user_text:
            command = "rm -rf /tmp/mock-target"
        elif "docker logs" in lowered or "docker log" in lowered or "docker 日志" in user_text:
            command = "docker logs --tail 50 mock-container"
        elif "docker" in lowered:
            command = "docker ps"
        elif "disk" in lowered or "磁盘" in user_text:
            command = "df -h"
        elif "memory" in lowered or "内存" in user_text:
            command = "wmic OS get FreePhysicalMemory"
        elif "process" in lowered or "进程" in user_text or "ps " in lowered:
            command = "tasklist"
        elif "status" in lowered or "服务状态" in user_text:
            command = "sc query mock-service"
        elif "log" in lowered or "日志" in user_text:
            command = "wevtutil qe System /c:5 /f:text"
        elif "commit" in lowered or "提交" in user_text:
            command = "git status --short"
        else:
            command = "python -c \"print('mock test ok')\""
        return {"command": command}
    return {}


def _trace(tool: str, arguments: dict[str, Any]) -> None:
    """ROVEAGENT_MOCK_TRACE=1 时把本轮决策打到 stderr（诊断定位用）。"""
    if os.environ.get("ROVEAGENT_MOCK_TRACE") != "1":
        return
    try:
        sys.stderr.write(
            f"[mock-llm] tool={tool} args={json.dumps(arguments, ensure_ascii=False)}\n"
        )
        sys.stderr.flush()
    except Exception:  # noqa: BLE001
        pass


def _decide(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """确定性决策：本轮该出工具调用还是终稿。

    改造（Phase 2b）：原先只看「有没有 tool 结果」，因此一轮只能调一个工具。
    现在改为「看哪些工具已经调过」，从而能驱动多步执行闭环
    （读 → 写 → patch → 跑测试 → 提交），每一步都产生真实副作用。
    """
    user_text = _last_user_text(messages)
    already = _tools_already_called(messages)

    tool = _pick_tool(user_text, already)
    if tool is not None:
        arguments = _build_arguments(tool, user_text)
        _trace(tool, arguments)
        return {
            "kind": "tool_call",
            "tool": tool,
            "arguments": arguments,
        }

    if already:
        return {
            "kind": "text",
            "text": (
                "执行完成。已按顺序调用：" + ", ".join(sorted(already))
                + "。所有工具调用均经 EnterpriseToolGate 判定。"
            ),
        }
    return {
        "kind": "text",
        "text": "Mock Provider 在线。这是用于验证 TS → Python Runtime → SSE 链路的测试回复。",
    }


class Handler(BaseHTTPRequestHandler):
    # HTTP/1.0：每条响应以「连接关闭」界定结束。
    #
    # 为什么不用 HTTP/1.1 + keep-alive：SSE 流没有 Content-Length，
    # 若声明 1.1 且不实现 chunked 分帧，客户端（httpx / Invoke-WebRequest）
    # 会一直等 Content-Length 直到超时。测试替身不需要连接复用，
    # 用 1.0 的 close-delimited 语义最稳妥。
    protocol_version = "HTTP/1.0"

    # 静音默认访问日志（内核轮询会刷屏）
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        if os.environ.get("ROVEAGENT_MOCK_VERBOSE") == "1":
            sys.stderr.write("[mock-llm] " + (fmt % args) + "\n")

    # -- 路由 ---------------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            body = json.dumps({
                "object": "list",
                "data": [{"id": MODEL_NAME, "object": "model",
                          "created": int(time.time()), "owned_by": "mock"}],
            }).encode("utf-8")
            self._send_json(200, body)
            return
        self._send_json(404, b'{"error":"not found"}')

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            self._send_json(404, b'{"error":"not found"}')
            return

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_json(400, b'{"error":"invalid json"}')
            return

        messages = payload.get("messages") or []
        stream = bool(payload.get("stream"))
        decision = _decide(messages)
        completion_id = f"chatcmpl-mock-{uuid.uuid4().hex[:12]}"
        created = int(time.time())

        if stream:
            self._send_stream(completion_id, created, decision)
        else:
            self._send_completion_once(completion_id, created, decision)

    # -- 响应实现 -----------------------------------------------------------
    def _send_json(self, status: int, body: bytes) -> None:
        """定长响应：Content-Length 明确，连接关闭由 1.0 语义保证。"""
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def _send_completion_once(self, completion_id: str, created: int,
                              decision: dict[str, Any]) -> None:
        if decision["kind"] == "tool_call":
            message: dict[str, Any] = {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": f"call_{uuid.uuid4().hex[:12]}",
                    "type": "function",
                    "function": {
                        "name": decision["tool"],
                        "arguments": json.dumps(decision["arguments"]),
                    },
                }],
            }
            finish = "tool_calls"
        else:
            message = {"role": "assistant", "content": decision["text"]}
            finish = "stop"

        body = json.dumps({
            "id": completion_id,
            "object": "chat.completion",
            "created": created,
            "model": MODEL_NAME,
            "choices": [{"index": 0, "message": message, "finish_reason": finish}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }, ensure_ascii=False).encode("utf-8")
        self._send_json(200, body)

    def _send_stream(self, completion_id: str, created: int,
                     decision: dict[str, Any]) -> None:
        """SSE 流：无 Content-Length，靠关闭连接界定结束（HTTP/1.0）。"""
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        try:
            # 首片：role
            self.wfile.write(_sse(_chunk(completion_id, created, {"role": "assistant"})))
            self.wfile.flush()

            if decision["kind"] == "tool_call":
                # OpenAI 约定：工具调用的 arguments 也是增量拼接的。
                # 一次给全便于内核解析，同时保留 tool_calls 结构。
                self.wfile.write(_sse(_chunk(completion_id, created, {
                    "tool_calls": [{
                        "index": 0,
                        "id": f"call_{uuid.uuid4().hex[:12]}",
                        "type": "function",
                        "function": {
                            "name": decision["tool"],
                            "arguments": json.dumps(decision["arguments"]),
                        },
                    }],
                })))
                self.wfile.flush()
                self.wfile.write(_sse(_chunk(completion_id, created, {}, "tool_calls")))
            else:
                for piece in _text_pieces(decision["text"]):
                    self.wfile.write(_sse(_chunk(completion_id, created, {"content": piece})))
                    self.wfile.flush()
                self.wfile.write(_sse(_chunk(completion_id, created, {}, "stop")))

            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # 客户端提前断开（用户点停止）：正常情况，静音
            pass


def main() -> int:
    port = int(os.environ.get("ROVEAGENT_MOCK_PORT", DEFAULT_PORT))
    host = os.environ.get("ROVEAGENT_MOCK_HOST", "127.0.0.1")
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True

    sys.stderr.write(
        f"[mock-llm] listening on http://{host}:{port}/v1  model={MODEL_NAME}\n"
        f"[mock-llm] NOT FOR PRODUCTION — test mode only\n"
    )
    sys.stderr.flush()

    # 供父进程（roveagent-service.sh）读取就绪信号
    if os.environ.get("ROVEAGENT_MOCK_READY_FILE"):
        try:
            with open(os.environ["ROVEAGENT_MOCK_READY_FILE"], "w", encoding="utf-8") as fh:
                fh.write("ready\n")
        except OSError:
            pass

    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
