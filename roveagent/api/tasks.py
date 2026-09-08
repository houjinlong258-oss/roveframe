"""任务存储 — 自主业务任务（Phase 1 /api/agent/task, /status, /execute 的支撑）。

每个 (tenant_id, business_id) 一个 JSON 文件，与 kernel 的租户数据
目录约定一致。状态机：

    planned → awaiting_approval → approved → running → done | failed | rejected
"""
from __future__ import annotations

import json
import hashlib
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class TaskStep:
    id: str
    title: str
    assignee: str
    kind: str                    # analyze | propose | execute | measure
    status: str = "pending"      # pending | awaiting_approval | running | done | failed | skipped
    needs_approval: bool = False
    detail: str = ""             # LLM 细化方案（文案/预算/KPI），骨架模式下为空
    result: str = ""


@dataclass
class Task:
    id: str
    tenant_id: str
    business_id: str
    title: str
    objective: str = ""
    created_by: str = "user"     # user | goal_engine | agent key
    status: str = "planned"
    steps: list[TaskStep] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["steps"] = [asdict(s) for s in self.steps]
        return d

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Task":
        steps = [TaskStep(**s) for s in d.pop("steps", [])]
        return Task(steps=steps, **d)


class TaskStore:
    def __init__(self, root: Path) -> None:
        self.dir = Path(root) / "tasks"
        self.dir.mkdir(parents=True, exist_ok=True)

    def _path(self, tenant_id: str, business_id: str) -> Path:
        if not tenant_id or not business_id:
            raise ValueError("tenant_id and business_id are required")
        scope_hash = hashlib.sha256(
            f"{tenant_id}\0{business_id}".encode("utf-8")
        ).hexdigest()[:24]
        return self.dir / f"scope-{scope_hash}.json"

    def _load(self, tenant_id: str, business_id: str) -> list[Task]:
        p = self._path(tenant_id, business_id)
        if not p.exists():
            return []
        return [Task.from_dict(d) for d in json.loads(p.read_text(encoding="utf-8"))]

    def _save(self, tenant_id: str, business_id: str, tasks: list[Task]) -> None:
        tmp = self._path(tenant_id, business_id).with_suffix(".tmp")
        tmp.write_text(json.dumps([t.to_dict() for t in tasks],
                                  ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self._path(tenant_id, business_id))

    def create(self, task: Task) -> Task:
        tasks = self._load(task.tenant_id, task.business_id)
        tasks.append(task)
        self._save(task.tenant_id, task.business_id, tasks)
        return task

    def get(self, tenant_id: str, business_id: str, task_id: str) -> Optional[Task]:
        for t in self._load(tenant_id, business_id):
            if t.id == task_id:
                return t
        return None

    def update(self, task: Task) -> Task:
        task.updated_at = time.time()
        tasks = self._load(task.tenant_id, task.business_id)
        for i, t in enumerate(tasks):
            if t.id == task.id:
                tasks[i] = task
                break
        else:
            tasks.append(task)
        self._save(task.tenant_id, task.business_id, tasks)
        return task

    def list(self, tenant_id: str, business_id: str, limit: int = 50) -> list[Task]:
        return sorted(
            self._load(tenant_id, business_id), key=lambda t: -t.created_at
        )[:limit]


def new_task(tenant_id: str, business_id: str, title: str, objective: str = "",
             steps: Optional[list[TaskStep]] = None,
             created_by: str = "user") -> Task:
    return Task(id=uuid.uuid4().hex[:12], tenant_id=tenant_id,
                business_id=business_id, title=title,
                objective=objective, steps=steps or [], created_by=created_by)
