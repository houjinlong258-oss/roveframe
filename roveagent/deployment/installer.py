"""RoveAgent Installer —— 一句话部署。

输入：服务器地址 + SSH 权限 + 域名 + 行业类型
流程：检测环境 → 安装依赖 → 配置 Docker → 创建数据库 → 部署应用 → 配置 SSL → 绑定域名 → 启动监控

dry_run=True 时只做环境检测与计划生成（默认，安全）；
dry_run=False 时通过 SSH 真实执行。所有步骤记录状态，可断点续跑。

P0-13 安全加固（威胁模型见 docs/current/EXPERIMENTAL_MODULES.md）：
- host/ssh_user/app_dir/domain 全部白名单校验后才允许拼入 SSH 命令；
- 数据库口令不再硬编码：每个计划生成独立随机口令（仅存于本机状态文件）；
- 本模块当前无任何 API/任务路径接线（仅 kernel 构造）；若未来接线，
  必须复用 RoveFrame 侧审批链路，非 dry_run 执行前需真实人工批准。
"""

from __future__ import annotations

import json
import re
import secrets
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional

_HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,253}$")
_SSH_USER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,31}$")
_APP_DIR_RE = re.compile(r"^/[A-Za-z0-9._/-]{1,200}$")
_DOMAIN_RE = re.compile(
    r"^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$",
)


def _validate_deploy_inputs(host: str, ssh_user: str, app_dir: str, domain: str) -> None:
    """P0-13：所有拼入远程命令的输入白名单校验，非法即拒绝（fail-closed）。"""
    if not _HOST_RE.fullmatch(host):
        raise ValueError(f"invalid host: {host!r}")
    if not _SSH_USER_RE.fullmatch(ssh_user):
        raise ValueError(f"invalid ssh_user: {ssh_user!r}")
    if not _APP_DIR_RE.fullmatch(app_dir):
        raise ValueError(f"invalid app_dir: {app_dir!r} (absolute path, [A-Za-z0-9._/-])")
    if not _DOMAIN_RE.fullmatch(domain):
        raise ValueError(f"invalid domain: {domain!r}")


@dataclass
class DeployStep:
    key: str
    label: str
    command: str
    status: str = "pending"  # pending | running | done | failed | skipped
    output: str = ""


@dataclass
class DeployPlan:
    plan_id: str
    host: str
    domain: str
    industry: str
    steps: list[DeployStep] = field(default_factory=list)
    status: str = "planned"  # planned | running | done | failed
    created_at: float = field(default_factory=time.time)
    db_password: str = ""    # P0-13：每计划独立随机口令，仅存本机状态文件


class RoveAgentInstaller:
    def __init__(self, state_dir: Path):
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)

    # ---------- 计划生成 ----------

    def build_plan(self, host: str, domain: str, industry: str = "restaurant",
                   ssh_user: str = "root", app_dir: str = "/opt/roveframe") -> DeployPlan:
        # P0-13：输入白名单校验后再拼命令
        _validate_deploy_inputs(host, ssh_user, app_dir, domain)
        target = f"{ssh_user}@{host}"
        db_password = secrets.token_urlsafe(18)  # 不再硬编码口令
        steps = [
            DeployStep("detect_env", "检测环境",
                       f"ssh {target} 'uname -a && (docker --version || true) && (node --version || true)'"),
            DeployStep("install_deps", "安装依赖",
                       f"ssh {target} 'apt-get update && apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx'"),
            DeployStep("configure_docker", "配置 Docker",
                       f"ssh {target} 'systemctl enable --now docker'"),
            DeployStep("create_database", "创建数据库",
                       f"ssh {target} 'docker run -d --name roveframe-db -e POSTGRES_PASSWORD={db_password} -p 5432:5432 postgres:16 || docker start roveframe-db'"),
            DeployStep("deploy_app", "部署应用",
                       f"ssh {target} 'mkdir -p {app_dir} && cd {app_dir} && docker compose up -d'"),
            DeployStep("configure_ssl", "配置 SSL",
                       f"ssh {target} 'certbot --nginx -d {domain} --non-interactive --agree-tos -m admin@{domain} || true'"),
            DeployStep("bind_domain", "绑定域名",
                       f"ssh {target} 'nginx -t && systemctl reload nginx'"),
            DeployStep("start_monitoring", "启动监控",
                       f"ssh {target} 'cd {app_dir} && docker compose ps && curl -sf http://localhost:5000/api/health || true'"),
        ]
        plan = DeployPlan(uuid.uuid4().hex[:10], host, domain, industry,
                          steps, db_password=db_password)
        self._save(plan)
        return plan

    # ---------- 执行 ----------

    def run(self, plan_id: str, dry_run: bool = True,
            step_timeout: int = 300) -> DeployPlan:
        plan = self._load(plan_id)
        plan.status = "running"
        self._save(plan)
        for step in plan.steps:
            if step.status == "done":
                continue  # 断点续跑
            step.status = "running"
            self._save(plan)
            if dry_run:
                # 干跑：本地环境检测真实执行，远程步骤只校验命令形态
                if step.key == "detect_env":
                    step.output = self._detect_local()
                else:
                    step.output = f"[dry-run] would execute: {step.command}"
                step.status = "done"
            else:
                ok, out = self._exec(step.command, step_timeout)
                step.output = out[-4000:]
                step.status = "done" if ok else "failed"
                if not ok:
                    plan.status = "failed"
                    self._save(plan)
                    return plan
            self._save(plan)
        plan.status = "done"
        self._save(plan)
        return plan

    # ---------- 内部 ----------

    def _detect_local(self) -> str:
        parts = []
        for tool in ("docker", "node", "python3"):
            parts.append(f"{tool}: {shutil.which(tool) or 'NOT FOUND'}")
        return "\n".join(parts)

    def _exec(self, command: str, timeout: int) -> tuple[bool, str]:
        # P0-13：命令仅由 build_plan 生成（输入已白名单校验）；此处保留
        # shell=True 是因为远端命令是整句 shell 脚本。若未来接受外部命令，
        # 必须先过输入校验，禁止任何未校验拼接。
        try:
            proc = subprocess.run(command, shell=True, capture_output=True,
                                  text=True, timeout=timeout)
            return proc.returncode == 0, (proc.stdout or "") + (proc.stderr or "")
        except subprocess.TimeoutExpired:
            return False, f"timeout after {timeout}s"

    def _path(self, plan_id: str) -> Path:
        return self.state_dir / f"deploy-{plan_id}.json"

    def _save(self, plan: DeployPlan) -> None:
        self._path(plan.plan_id).write_text(
            json.dumps(asdict(plan), ensure_ascii=False, indent=2), encoding="utf-8")

    def _load(self, plan_id: str) -> DeployPlan:
        d = json.loads(self._path(plan_id).read_text(encoding="utf-8"))
        d["steps"] = [DeployStep(**s) for s in d["steps"]]
        return DeployPlan(**d)

    def get_plan(self, plan_id: str) -> Optional[DeployPlan]:
        if self._path(plan_id).exists():
            return self._load(plan_id)
        return None
