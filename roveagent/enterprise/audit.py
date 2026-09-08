"""审计日志：所有 Agent 操作必须留痕（产品级要求 #3）。

append-only JSONL，每租户一个文件，支持按 agent/action/时间范围查询。
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable, Optional


@dataclass
class AuditEvent:
    tenant_id: str
    agent: str
    action: str
    detail: str
    result: str  # ok | denied | error | pending_approval
    event_id: str = ""
    ts: float = 0.0

    def __post_init__(self) -> None:
        if not self.event_id:
            self.event_id = uuid.uuid4().hex[:12]
        if not self.ts:
            self.ts = time.time()


class AuditLog:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def record(self, event: AuditEvent) -> AuditEvent:
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(asdict(event), ensure_ascii=False) + "\n")
        return event

    def query(
        self,
        agent: Optional[str] = None,
        action: Optional[str] = None,
        since: float = 0.0,
        limit: int = 100,
    ) -> list[AuditEvent]:
        if not self.path.exists():
            return []
        out: list[AuditEvent] = []
        with self.path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                ev = AuditEvent(**json.loads(line))
                if agent and ev.agent != agent:
                    continue
                if action and ev.action != action:
                    continue
                if ev.ts < since:
                    continue
                out.append(ev)
        return out[-limit:]

    def all(self) -> Iterable[AuditEvent]:
        return self.query(limit=1_000_000)
