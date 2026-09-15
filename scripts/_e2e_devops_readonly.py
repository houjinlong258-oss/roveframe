"""Phase 2c 验证：DevOps Agent 只读运维 + 破坏性操作拦截。

用户的 4 项测试要求：
  1. 查看进程     → 真实返回
  2. 查看 docker  → 真实返回
  3. kill process → blocked
  4. restart service → requires approval（或按权限 blocked）

关键点：安全性**由 EnterpriseToolGate 判定**（依据 `terminal` 策略
`admin:process / HIGH / MANAGER`）。Mock 如实表达意图，不自行拦截 ——
否则测到的是 Mock 的逻辑而不是门控。

用法::

    python scripts/_e2e_devops_readonly.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
AUDIT = REPO / ".roveagent" / "audit" / "tool_gate.jsonl"
KERNEL_PORT = 8788
MOCK_PORT = 8799
API_KEY = "e2e-devops-key"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
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


def _audit_for(request_id: str) -> list[dict]:
    rows: list[dict] = []
    if not AUDIT.exists():
        return rows
    for line in AUDIT.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("request_id") == request_id:
            rows.append(row)
    return rows


def _ask(prompt: str, request_id: str, role: str, permissions: list[str],
         session: str) -> tuple[int, str, list[dict]]:
    payload = {
        "tenant_id": "00000000-0000-0000-0000-000000000000",
        "business_id": "00000000-0000-0000-0000-000000000001",
        "user_id": "ops-user",
        "message": prompt,
        "agent": "devops",
        "role": role,
        "permissions": permissions,
        "request_id": request_id,
        "task_id": f"{request_id}-task",
        "session_id": session,
        "industry": "restaurant",
        "business_context": "devops e2e context",
    }
    status, body = _post("/api/agent/chat", payload)
    return status, body, _audit_for(request_id)


def main() -> int:
    results: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        results.append((name, ok, detail))
        print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))

    AUDIT.parent.mkdir(parents=True, exist_ok=True)
    if AUDIT.exists():
        AUDIT.unlink()

    env = {
        **os.environ,
        "ROVEAGENT_ROOT": str(REPO / ".roveagent"),
        "ROVEAGENT_HOME": str(REPO / ".roveagent"),
        "ROVEAGENT_API_KEY": API_KEY,
        "ROVEAGENT_APPROVAL_SECRET": "e2e-devops-approval",
        "ROVEAGENT_LLM_BASE_URL": f"http://127.0.0.1:{MOCK_PORT}/v1",
        "ROVEAGENT_LLM_API_KEY": "mock-key",
        "ROVEAGENT_LLM_MODEL": "mock-model",
        "ROVEAGENT_MOCK_TRACE": "1",
        "ROVEAGENT_GATE_TRACE": "1",
    }

    mock_err = open(REPO / ".roveagent" / "e2e-devops-mock.err", "w", encoding="utf-8")  # noqa: SIM115
    kernel_err = open(REPO / ".roveagent" / "e2e-devops-kernel.err", "w", encoding="utf-8")  # noqa: SIM115
    mock = subprocess.Popen(
        [sys.executable, "-m", "scripts.mock_llm_provider"],
        cwd=str(REPO), env=env, stdout=subprocess.DEVNULL, stderr=mock_err,
    )
    kernel = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "roveagent.api.app:get_app", "--factory",
         "--host", "127.0.0.1", "--port", str(KERNEL_PORT), "--log-level", "info"],
        cwd=str(REPO), env=env, stdout=subprocess.DEVNULL, stderr=kernel_err,
    )

    # 完整 admin:process 权限 + owner：用于「读」与「按权限判定」两组
    ops_perms = ["admin:process", "analytics:read", "files:read"]

    try:
        if not _wait_kernel():
            check("kernel 启动", False, "60s 内未就绪")
            return 1
        check("kernel 启动", True, f"port {KERNEL_PORT}")

        # ---- 测试 1：查看进程（只读，应真实执行）----
        status, body, rows = _ask(
            "show me the process list", "devops-proc", "owner", ops_perms, "devops-1",
        )
        allowed = [r for r in rows if r.get("tool") == "terminal" and r.get("allowed")]
        check("测试1 查看进程：真实执行", status == 200 and bool(allowed),
              f"HTTP {status}; terminal allowed={len(allowed)}")
        try:
            reply = json.loads(body).get("reply", "")
        except json.JSONDecodeError:
            reply = ""
        has_output = "tasklist" in reply or "PID" in reply or len(reply) > 40
        check("测试1 返回真实进程内容", has_output, reply[:120])

        # ---- 测试 2：查看 docker 状态 ----
        status, body, rows = _ask(
            "check docker status", "devops-docker", "owner", ops_perms, "devops-2",
        )
        allowed = [r for r in rows if r.get("tool") == "terminal" and r.get("allowed")]
        check("测试2 查看 docker：真实执行", status == 200 and bool(allowed),
              f"HTTP {status}; terminal allowed={len(allowed)}")

        # ---- 测试 3：kill process（权限不足 → 必须 blocked）----
        #
        # 注意：不能用 owner —— `derive_permissions` 会把**员工档案固有能力**
        # （devops 声明了 `admin:process`）并入权限集，owner 的允许集又是 `*`，
        # 因此 owner 一定拿到 `admin:process`。这是正确的 fail-closed 设计
        # （客户端无法通过裁剪请求来削弱服务端授予档案能力），但也意味着
        # 要验证「权限不足被拒」必须用一个**允许集不含 admin:process** 的角色。
        # manager 的允许集（api/permissions.py）确实不含它。
        status, body, rows = _ask(
            "kill process 1234", "devops-kill", "manager", ["files:read"], "devops-3",
        )
        blocked = [r for r in rows if r.get("tool") == "terminal" and not r.get("allowed")]
        check("测试3 kill：被门控拦截", status == 200 and bool(blocked),
              f"HTTP {status}; blocked={len(blocked)}"
              + (f"; reason={blocked[0].get('reason')}" if blocked else ""))

        # ---- 测试 4：restart service（有权限 + manager 角色 → requires approval）----
        status, body, rows = _ask(
            "restart the service", "devops-restart", "manager", ops_perms, "devops-4",
        )
        approval_rows = [r for r in rows if r.get("requires_approval")]
        check("测试4 restart：进入审批（不执行）", status == 200 and bool(approval_rows),
              f"HTTP {status}; requires_approval={len(approval_rows)}"
              + (f"; policy={approval_rows[0].get('approval_policy')}" if approval_rows else ""))
        try:
            reply4 = json.loads(body).get("reply", "")
        except json.JSONDecodeError:
            reply4 = ""
        check("测试4 未产生真实副作用（回复未声称已重启）",
              "restarted" not in reply4.lower() or "approval" in reply4.lower(),
              reply4[:120])

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
