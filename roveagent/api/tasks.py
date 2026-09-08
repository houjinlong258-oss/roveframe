"""任务存储 — 自主业务任务（Phase 1 /api/agent/task, /status, /execute 的支撑）。

每个 (tenant_id, business_id) 一个 JSON 文件，与 kernel 的租户数据
目录约定一致。状态机：

    planned → awaiting_approval → approved → running → done | failed | rejected

P0-12：带乐观锁（version）+ 进程内锁；并发读-改-写冲突抛
ConcurrentTaskUpdateError，杜绝双 execute 双双生效。
"""
from __future__ import annotations

import json
import hashlib
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional


class ConcurrentTaskUpdateError(Exception):
    """乐观锁冲突：任务已被并发修改，本次读-改-写作废。"""


@dataclass
class TaskStep:
    id: str
    title: str
    assignee: str
    kind: str                    # analyze | propose | execute | measure
    # pending | awaiting_approval | approved | running | done | failed | skipped
    # approved = 已批准/意图登记，等待 EnterpriseToolGate 工具链真实执行
    status: str = "pending"
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
    version: int = 0             # P0-12：乐观锁版本号

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
        # P0-12：per-scope 进程内锁（乐观锁之外的粗粒度互斥兜底）
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _path(self, tenant_id: str, business_id: str) -> Path:
        if not tenant_id or not business_id:
            raise ValueError("tenant_id and business_id are required")
        scope_hash = hashlib.sha256(
            f"{tenant_id}\0{business_id}".encode("utf-8")
        ).hexdigest()[:24]
        return self.dir / f"scope-{scope_hash}.json"

    def _lock_for(self, tenant_id: str, business_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(f"{tenant_id}\0{business_id}")
            if lock is None:
                lock = threading.Lock()
                self._locks[f"{tenant_id}\0{business_id}"] = lock
            return lock

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
        with self._lock_for(task.tenant_id, task.business_id):
            tasks = self._load(task.tenant_id, task.business_id)
            task.version = 0
            tasks.append(task)
            self._save(task.tenant_id, task.business_id, tasks)
            return task

    def get(self, tenant_id: str, business_id: str, task_id: str) -> Optional[Task]:
        for t in self._load(tenant_id, business_id):
            if t.id == task_id:
                return t
        return None

    def update(self, task: Task,
               expected_version: Optional[int] = None) -> Task:
        """乐观更新：expected_version 缺省取 task.version，与存储不一致即冲突。"""
        with self._lock_for(task.tenant_id, task.business_id):
            task.updated_at = time.time()
            tasks = self._load(task.tenant_id, task.business_id)
            for i, t in enumerate(tasks):
                if t.id == task.id:
                    expected = (task.version if expected_version is None
                                else expected_version)
                    if t.version != expected:
                        raise ConcurrentTaskUpdateError(
                            f"task {task.id} was modified concurrently "
                            f"(stored v{t.version} != expected v{expected})")
                    task.version = t.version + 1
                    tasks[i] = task
                    self._save(task.tenant_id, task.business_id, tasks)
                    return task
            task.version = 0
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
