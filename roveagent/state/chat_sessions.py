"""chat 端点会话级多轮上下文持久化（蓝图路线图项）。

RoveAgent Service 的 /api/agent/chat 原来每次调用都是新 AIAgent，
消息列表跨调用不持久。本模块提供按
``(tenant_id, business_id, user_id, session_id)`` 隔离的
轻量会话存储，chat 端点在调用前把历史以 prefill_messages 注入
Agent Loop，调用后把本轮 user/assistant 落库。

存储：``<root>/chat_sessions.db``（SQLite，单文件，与
enterprise_memory 同一部署约定）。保留最近 MAX_TURNS 轮，
超长自动截断（上下文成本控制）。
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

MAX_TURNS = 20          # 注入历史的最大轮数（一轮 = user + assistant）
_KEEP_ROWS = 200        # 每会话最多落库消息条数

_SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  business_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts REAL NOT NULL
);
"""


class ChatSessionStore:
    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self.db.executescript(_SCHEMA)
        columns = {
            row[1] for row in self.db.execute("PRAGMA table_info(chat_messages)")
        }
        if "business_id" not in columns:
            self.db.execute(
                "ALTER TABLE chat_messages ADD COLUMN business_id TEXT NOT NULL DEFAULT ''"
            )
        if "user_id" not in columns:
            self.db.execute(
                "ALTER TABLE chat_messages ADD COLUMN user_id TEXT NOT NULL DEFAULT ''"
            )
        self.db.execute("DROP INDEX IF EXISTS chat_messages_sess_idx")
        self.db.execute(
            "CREATE INDEX chat_messages_sess_idx ON chat_messages "
            "(tenant_id, business_id, user_id, session_id, id)"
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    @staticmethod
    def new_session_id() -> str:
        return uuid.uuid4().hex[:12]

    # ------------------------------------------------------------------
    def append(self, tenant_id: str, business_id: str, user_id: str,
               session_id: str, agent: str, role: str, content: str) -> None:
        if not tenant_id or not business_id or not user_id or not session_id:
            raise ValueError("tenant, business, user and session scope are required")
        self.db.execute(
            "INSERT INTO chat_messages "
            "(tenant_id, business_id, user_id, session_id, agent, role, content, ts)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (tenant_id, business_id, user_id, session_id, agent, role,
             content, time.time()),
        )
        # 截断：仅保留每会话最近 _KEEP_ROWS 条
        self.db.execute(
            "DELETE FROM chat_messages WHERE tenant_id=? AND business_id=? "
            "AND user_id=? AND session_id=? AND id <"
            " (SELECT min(id) FROM (SELECT id FROM chat_messages"
            "  WHERE tenant_id=? AND business_id=? AND user_id=? AND session_id=?"
            "  ORDER BY id DESC LIMIT ?))",
            (tenant_id, business_id, user_id, session_id,
             tenant_id, business_id, user_id, session_id, _KEEP_ROWS),
        )
        self.db.commit()

    def history(self, tenant_id: str, business_id: str, user_id: str,
                session_id: str,
                limit: int = MAX_TURNS * 2) -> list[dict[str, Any]]:
        """返回按时间正序的 [{role, content}]（可直接作 prefill_messages）。"""
        cur = self.db.execute(
            "SELECT role, content FROM chat_messages"
            " WHERE tenant_id=? AND business_id=? AND user_id=? AND session_id=?"
            " ORDER BY id DESC LIMIT ?",
            (tenant_id, business_id, user_id, session_id, limit),
        )
        rows = cur.fetchall()
        return [{"role": r, "content": c} for r, c in reversed(rows)]

    def list_sessions(self, tenant_id: str, business_id: str, user_id: str,
                      limit: int = 50) -> list[dict[str, Any]]:
        """当前 tenant/business/user 会话列表（最近活跃在前）。"""
        cur = self.db.execute(
            "SELECT session_id, agent, COUNT(*), MAX(ts) FROM chat_messages"
            " WHERE tenant_id=? AND business_id=? AND user_id=?"
            " GROUP BY session_id, agent ORDER BY MAX(ts) DESC LIMIT ?",
            (tenant_id, business_id, user_id, limit),
        )
        return [{"session_id": s, "agent": a, "messages": n, "updated_at": t}
                for s, a, n, t in cur.fetchall()]

    def delete_session(self, tenant_id: str, business_id: str, user_id: str,
                       session_id: str) -> int:
        cur = self.db.execute(
            "DELETE FROM chat_messages WHERE tenant_id=? AND business_id=?"
            " AND user_id=? AND session_id=?",
            (tenant_id, business_id, user_id, session_id),
        )
        self.db.commit()
        return cur.rowcount
