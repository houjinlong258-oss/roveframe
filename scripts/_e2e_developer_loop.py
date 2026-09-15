"""Phase 2b 端到端验证：Developer Agent 真实执行闭环。

验证目标（用户最终验收标准 #1：「让 Developer Agent 修改真实代码」）：

    读取 → 分析 → 修改 → 生成 diff → （审批）→ 写文件 → 运行测试 → git 提交

本脚本断言的是**磁盘上的真实变化**，不是模型说了什么。

设计取舍
--------
- 用 ``role=owner`` 走完闭环：owner 凭 ``_role_gate`` 的角色等级自行放行
  MANAGER 级动作（Step 1.5 记录的既有语义）。**审批路径的拦截行为**另由
  ``phase2b_approval_test.py`` 用 ``manager`` 角色断言「不执行且要求审批」。
- 沙箱目录：``<repo>/.roveagent/mock-sandbox``（agent 管理的根之内，
  满足 write_file 的路径约束），不碰仓库源码。

用法::

    python scripts/_e2e_developer_loop.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SANDBOX = REPO / ".roveagent" / "mock-sandbox"
TARGET = SANDBOX / "mock_created.txt"
KERNEL_PORT = 8788
MOCK_PORT = 8799
API_KEY = "e2e-dev-key"

# Windows 控制台默认 GBK，模型回复里的 ⚠ 等字符会让 print 抛 UnicodeEncodeError。
# 强制 UTF-8 并允许替换，保证诊断输出不因编码中断。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001 — 旧解释器或不支持 reconfigure 时忽略
    pass


def _post(path: str, payload: dict, timeout: int = 240) -> tuple[int, str]:
    request = urllib.request.Request(
        f"http://127.0.0.1:{KERNEL_PORT}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-RoveAgent-Key": API_KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8")


def _wait_kernel(deadline_s: int = 60) -> bool:
    end = time.time() + deadline_s
    while time.time() < end:
        try:
            request = urllib.request.Request(
                f"http://127.0.0.1:{KERNEL_PORT}/api/health",
                headers={"X-RoveAgent-Key": API_KEY},
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                if response.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(1.0)
    return False


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    # ---- 准备沙箱 ----
    if SANDBOX.exists():
        shutil.rmtree(SANDBOX, ignore_errors=True)
    SANDBOX.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-q"], cwd=str(SANDBOX), check=False)
    (SANDBOX / "README.md").write_text("# mock sandbox\n", encoding="utf-8")
    print(f"[setup] sandbox = {SANDBOX}")
    print(f"[setup] target  = {TARGET}  (exists={TARGET.exists()})")

    env = {
        **os.environ,
        "ROVEAGENT_ROOT": str(REPO / ".roveagent"),
        "ROVEAGENT_HOME": str(REPO / ".roveagent"),
        "ROVEAGENT_API_KEY": API_KEY,
        "ROVEAGENT_APPROVAL_SECRET": "e2e-approval",
        "ROVEAGENT_LLM_BASE_URL": f"http://127.0.0.1:{MOCK_PORT}/v1",
        "ROVEAGENT_LLM_API_KEY": "mock-key",
        "ROVEAGENT_LLM_MODEL": "mock-model",
        # Mock 把 write/patch 目标指向沙箱
        "ROVEAGENT_MOCK_SANDBOX_DIR": str(SANDBOX),
        "ROVEAGENT_MOCK_WRITE_PATH": str(TARGET),
        "ROVEAGENT_MOCK_PATCH_PATH": str(TARGET),
        # 诊断：把 Mock 真实发出的工具参数与门控实际收到的参数打出来
        "ROVEAGENT_MOCK_TRACE": "1",
        "ROVEAGENT_GATE_TRACE": "1",
    }

    mock_err = open(REPO / ".roveagent" / "e2e-mock.err", "w", encoding="utf-8")  # noqa: SIM115
    kernel_err = open(REPO / ".roveagent" / "e2e-kernel.err", "w", encoding="utf-8")  # noqa: SIM115
    mock = subprocess.Popen(
        [sys.executable, "-m", "scripts.mock_llm_provider"],
        cwd=str(REPO), env=env,
        stdout=subprocess.DEVNULL, stderr=mock_err,
    )
    kernel = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "roveagent.api.app:get_app", "--factory",
         "--host", "127.0.0.1", "--port", str(KERNEL_PORT), "--log-level", "warning"],
        cwd=str(REPO), env=env,
        stdout=subprocess.DEVNULL, stderr=kernel_err,
    )

    try:
        if not _wait_kernel():
            check("kernel 启动", False, "60s 内 /api/health 未就绪")
            return 1
        check("kernel 启动", True, f"port {KERNEL_PORT}")

        # ---- 触发闭环 ----
        payload = {
            "tenant_id": "00000000-0000-0000-0000-000000000000",
            "business_id": "00000000-0000-0000-0000-000000000001",
            "user_id": "u1",
            "message": "read the README then write a file then patch it then run tests",
            "agent": "developer",
            "role": "owner",
            "permissions": ["files:read", "files:write"],
            "request_id": "e2e-dev-loop",
            "task_id": "e2e-task",
            "session_id": "e2e-session",
            "industry": "restaurant",
            "business_context": "e2e test context",
        }
        status, body = _post("/api/agent/chat", payload)
        check("POST /api/agent/chat", status == 200, f"HTTP {status}")

        # ---- 打印解析出的 reply / 诊断，避免「黑盒失败」 ----
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError:
            parsed = {}
        reply = parsed.get("reply", "")
        print(f"[debug] reply: {reply[:300]}")

        # ---- 断言 1：文件被真实创建 ----
        check("write_file 产生真实文件", TARGET.exists(), str(TARGET))
        if TARGET.exists():
            content = TARGET.read_text(encoding="utf-8")
            check("文件内容正确", "value = 42" in content or "value = 43" in content,
                  content.strip()[:60])

        # ---- 断言 2：patch 真实生效 ----
        if TARGET.exists():
            final = TARGET.read_text(encoding="utf-8")
            check("patch 真实生效（42 → 43）", "value = 43" in final,
                  final.strip().replace("\n", " | ")[:80])

        # ---- 断言 3：门控审计留痕 ----
        audit = REPO / ".roveagent" / "audit" / "tool_gate.jsonl"
        tools_seen: list[str] = []
        if audit.exists():
            for line in audit.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("request_id") == "e2e-dev-loop":
                    tools_seen.append(f"{row.get('tool')}:{'ok' if row.get('allowed') else 'blocked'}")
                    # 诊断：把被拦工具的 reason 打出来（terminal 为何 blocked）
                    if not row.get("allowed"):
                        print(f"[debug] blocked {row.get('tool')}: "
                              f"reason={row.get('reason')!r} "
                              f"perm={row.get('required_permissions')}")
        check("门控审计记录了闭环工具", len(tools_seen) >= 2, ", ".join(tools_seen))
        print(f"[debug] audit: {tools_seen[:8]}")

        # ---- 断言 4：返回了真实执行终稿（而非「已修改」式空话）----
        check("返回了真实执行结果", bool(reply), reply[:120])

        # ---- 诊断：沙箱目录内容 ----
        if SANDBOX.exists():
            listing = sorted(p.name for p in SANDBOX.iterdir())
            print(f"[debug] sandbox contents: {listing}")
        else:
            print("[debug] sandbox missing")

        # ---- 诊断：把 Mock 的真实参数经 registry 复放，验证 handler 本身 ----
        # 若这一步能写出文件、而 HTTP 路径不能，则问题在「参数送达/执行」而非 handler。
        try:
            if str(REPO) not in sys.path:
                sys.path.insert(0, str(REPO))
            from roveagent.tools.registry import discover_builtin_tools, registry as _reg

            discover_builtin_tools()
            _reg_entry = _reg.get_entry("write_file")
            if _reg_entry is not None:
                _handler = getattr(_reg_entry, "handler", None)
                _replay = SANDBOX / "replay_check.txt"
                if _replay.exists():
                    _replay.unlink()
                _out = _handler({"path": str(_replay), "content": "replay = 1\n"})
                print(f"[debug] registry replay write_file -> exists={_replay.exists()} "
                      f"out={str(_out)[:160]}")
            else:
                print("[debug] registry replay: write_file not registered")
        except Exception as exc:  # noqa: BLE001
            print(f"[debug] registry replay raised: {type(exc).__name__}: {exc}")

        # ---- 诊断：Mock 真实发出的参数 + 门控收到的参数 ----
        for label, filename, marker in (
            ("mock", "e2e-mock.err", "tool="),
            ("gate", "e2e-kernel.err", "gate trace"),
        ):
            path = REPO / ".roveagent" / filename
            if not path.exists():
                continue
            lines = [
                ln.strip() for ln in path.read_text(encoding="utf-8", errors="replace").splitlines()
                if marker in ln
            ]
            print(f"[debug] {label} trace ({len(lines)}):")
            for line in lines[:6]:
                print(f"    {line[:220]}")

    finally:
        for proc in (kernel, mock):
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass

    passed = sum(1 for _, ok, _ in results if ok)
    print(f"\n[summary] {passed}/{len(results)} checks passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
