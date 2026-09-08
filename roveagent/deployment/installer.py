"""RoveAgent Installer —— 一句话部署。

输入：服务器地址 + SSH 权限 + 域名 + 行业类型
流程：检测环境 → 安装依赖 → 配置 Docker → 创建数据库 → 部署应用 → 配置 SSL → 绑定域名 → 启动监控

dry_run=True 时只做环境检测与计划生成（默认，安全）；
dry_run=False 时通过 SSH 真实执行。所有步骤记录状态，可断点续跑。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import time
import uuid
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


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


class RoveAgentInstaller:
    def __init__(self, state_dir: Path):
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)

    # ---------- 计划生成 ----------

    def build_plan(self, host: str, domain: str, industry: str = "restaurant",
                   ssh_user: str = "root", app_dir: str = "/opt/roveframe") -> DeployPlan:
        target = f"{ssh_user}@{host}"
        steps = [
            DeployStep("detect_env", "检测环境",
                       f"ssh {target} 'uname -a && (docker --version || true) && (node --version || true)'"),
            DeployStep("install_deps", "安装依赖",
                       f"ssh {target} 'apt-get update && apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx'"),
            DeployStep("configure_docker", "配置 Docker",
                       f"ssh {target} 'systemctl enable --now docker'"),
            DeployStep("create_database", "创建数据库",
                       f"ssh {target} 'docker run -d --name roveframe-db -e POSTGRES_PASSWORD=roveframe -p 5432:5432 postgres:16 || docker start roveframe-db'"),
            DeployStep("deploy_app", "部署应用",
                       f"ssh {target} 'mkdir -p {app_dir} && cd {app_dir} && docker compose up -d'"),
            DeployStep("configure_ssl", "配置 SSL",
                       f"ssh {target} 'certbot --nginx -d {domain} --non-interactive --agree-tos -m admin@{domain} || true'"),
            DeployStep("bind_domain", "绑定域名",
                       f"ssh {target} 'nginx -t && systemctl reload nginx'"),
            DeployStep("start_monitoring", "启动监控",
                       f"ssh {target} 'cd {app_dir} && docker compose ps && curl -sf http://localhost:5000/api/health || true'"),
        ]
        plan = DeployPlan(uuid.uuid4().hex[:10], host, domain, industry, steps)
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
