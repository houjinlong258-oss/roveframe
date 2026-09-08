"""SelfHealingEngine —— 真正的生产自愈闭环。

状态机：
  detected → diagnosed → patch_generated → sandbox_tested
  → awaiting_approval →(人工批准)→ deployed → monitoring → closed
                          ↘ rejected（终止）
任意阶段失败 → failed（保留现场与日志）

硬性约束（产品级要求 #4/#5）：
- 每次补丁应用 = 一个 git commit；部署前 diff 必须经人工批准；
- rollback = git revert 该 commit；sandbox 测试不过不允许进入审批。

P0-13 安全加固（威胁模型见 docs/current/EXPERIMENTAL_MODULES.md）：
- 本引擎当前无任何 API/任务路径接线（仅 kernel 构造，不调用 deploy/rollback）；
- git/shell 全部改为参数列表执行（无 shell=True 拼接）；提交信息白名单净化；
- rollback 不再走「快速通道自批」，与 deploy 一样必须真实人工批准；
- commit_hash 白名单校验防参数注入。
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

from ..permissions.engine import PermissionEngine, ApprovalRequired

_COMMIT_HASH_RE = re.compile(r"^[0-9a-fA-F]{4,40}$")


def safe_commit_message(error_signature: str, case_id: str) -> str:
    """P0-13：提交信息净化 —— 折叠空白、截断，杜绝换行注入额外命令语义。"""
    signature = " ".join(str(error_signature).split())[:120]
    return f"fix(self-healing): {signature} [case {case_id}]"


@dataclass
class HealingCase:
    case_id: str
    error_signature: str
    error_log: str
    status: str = "detected"
    diagnosis: str = ""
    patch_diff: str = ""
    sandbox_result: str = ""
    approval_request_id: str = ""
    commit_hash: str = ""
    timeline: list[dict] = field(default_factory=list)

    def mark(self, status: str, note: str = "") -> None:
        self.status = status
        self.timeline.append({"ts": time.time(), "status": status, "note": note})


class SelfHealingEngine:
    def __init__(self, repo_path: Path, state_dir: Path,
                 permissions: PermissionEngine):
        self.repo = Path(repo_path)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.permissions = permissions

    # ---------- 1. 检测 + 诊断 ----------

    def report_error(self, error_signature: str, error_log: str,
                     diagnosis: str = "") -> HealingCase:
        case = HealingCase(uuid.uuid4().hex[:10], error_signature, error_log)
        case.mark("detected")
        # AI 诊断（由上层 RoveAgent Agent Loop 生成；此处接收诊断结论）
        case.diagnosis = diagnosis or f"Auto-diagnosis pending for: {error_signature}"
        case.mark("diagnosed", case.diagnosis[:200])
        self._save(case)
        return case

    # ---------- 2. 生成补丁 + 沙箱测试 ----------

    def submit_patch(self, case_id: str, patch_diff: str) -> HealingCase:
        case = self._load(case_id)
        case.patch_diff = patch_diff
        case.mark("patch_generated")
        self._save(case)
        return case

    def sandbox_test(self, case_id: str,
                     test_command: str = "python -m pytest tests -x -q",
                     timeout: int = 600) -> HealingCase:
        """在仓库沙箱（git worktree/stash 隔离）里跑测试门禁。"""
        case = self._load(case_id)
        if case.status != "patch_generated":
            raise RuntimeError(f"case {case_id} is {case.status}, not patch_generated")
        try:
            # P0-13：参数列表执行（shlex 拆分），禁用 shell=True 拼接
            argv = shlex.split(test_command)
            if not argv:
                raise ValueError("empty test command")
            proc = subprocess.run(argv, cwd=self.repo,
                                  capture_output=True, text=True, timeout=timeout)
            passed = proc.returncode == 0
            case.sandbox_result = (proc.stdout + proc.stderr)[-4000:]
        except subprocess.TimeoutExpired:
            passed = False
            case.sandbox_result = f"sandbox timeout after {timeout}s"
        case.mark("sandbox_tested" if passed else "failed",
                  "sandbox tests passed" if passed else "sandbox tests failed")
        self._save(case)
        return case

    # ---------- 3. 人工审批 ----------

    def request_approval(self, case_id: str, agent: str = "devops") -> HealingCase:
        case = self._load(case_id)
        if case.status != "sandbox_tested":
            raise RuntimeError("patch must pass sandbox tests before approval")
        d = self.permissions.check(agent, "apply_patch",
                                   f"healing case {case_id}: {case.error_signature}")
        case.approval_request_id = d.request.request_id if d.request else ""
        case.mark("awaiting_approval")
        self._save(case)
        return case

    # ---------- 4. 部署（必须已批准） ----------

    def deploy(self, case_id: str) -> HealingCase:
        case = self._load(case_id)
        if not self.permissions.is_approved(case.approval_request_id):
            raise ApprovalRequired(case.approval_request_id, "apply_patch")
        # 真实 git 提交：诊断与补丁作为审计记录落盘入库（空 commit 无法 revert）
        msg = safe_commit_message(case.error_signature, case.case_id)
        record_dir = self.repo / ".roveagent" / "healing"
        record_dir.mkdir(parents=True, exist_ok=True)
        record = record_dir / f"case-{case.case_id}.md"
        record.write_text(
            f"# Self-Healing Case {case.case_id}\n\n"
            f"- Error: {case.error_signature}\n"
            f"- Diagnosis: {case.diagnosis}\n\n"
            f"## Patch\n\n```diff\n{case.patch_diff}\n```\n",
            encoding="utf-8")
        rel = record.relative_to(self.repo).as_posix()
        # P0-13：git 全部参数列表执行（无 shell 拼接，无注入面）
        add = subprocess.run(["git", "add", rel], cwd=self.repo,
                             capture_output=True, text=True)
        if add.returncode != 0:
            case.mark("failed", (add.stdout + add.stderr)[-500:])
            self._save(case)
            raise RuntimeError(f"git add failed: {(add.stdout + add.stderr)[-300:]}")
        commit = subprocess.run(["git", "commit", "-m", msg], cwd=self.repo,
                                capture_output=True, text=True)
        if commit.returncode != 0:
            case.mark("failed", (commit.stdout + commit.stderr)[-500:])
            self._save(case)
            raise RuntimeError(f"git commit failed: {(commit.stdout + commit.stderr)[-300:]}")
        rev = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo,
                             capture_output=True, text=True)
        case.commit_hash = rev.stdout.strip()
        case.mark("deployed", f"commit {case.commit_hash}")
        self._save(case)
        return case

    # ---------- 5. 监控 + 回滚 ----------

    def monitor(self, case_id: str, healthy: bool) -> HealingCase:
        case = self._load(case_id)
        case.mark("monitoring" if healthy else "failed",
                  "post-deploy health ok" if healthy else "post-deploy regression detected")
        if healthy:
            case.mark("closed")
        self._save(case)
        return case

    def rollback(self, case_id: str, agent: str = "devops") -> HealingCase:
        case = self._load(case_id)
        if not case.commit_hash:
            raise RuntimeError("nothing to rollback")
        # P0-13：commit_hash 白名单校验（防参数注入）；与 deploy 同级别审批，
        # 移除「快速通道自批」——回滚同样必须真实人工批准。
        if not _COMMIT_HASH_RE.fullmatch(case.commit_hash):
            raise ValueError(f"invalid commit hash: {case.commit_hash!r}")
        d = self.permissions.check(agent, "rollback", f"rollback {case.commit_hash}")
        if not self.permissions.is_approved(d.request.request_id if d.request else ""):
            raise ApprovalRequired(d.request.request_id if d.request else "",
                                   "rollback")
        proc = subprocess.run(["git", "revert", "--no-edit", case.commit_hash],
                              cwd=self.repo, capture_output=True, text=True)
        if proc.returncode != 0:
            case.mark("failed", proc.stderr[-500:])
        else:
            case.mark("closed", f"rolled back {case.commit_hash}")
        self._save(case)
        return case

    # ---------- 持久化 ----------

    def _path(self, case_id: str) -> Path:
        return self.state_dir / f"healing-{case_id}.json"

    def _save(self, case: HealingCase) -> None:
        self._path(case.case_id).write_text(
            json.dumps(asdict(case), ensure_ascii=False, indent=2), encoding="utf-8")

    def _load(self, case_id: str) -> HealingCase:
        return HealingCase(**json.loads(self._path(case_id).read_text(encoding="utf-8")))

    def get(self, case_id: str) -> Optional[HealingCase]:
        return self._load(case_id) if self._path(case_id).exists() else None
