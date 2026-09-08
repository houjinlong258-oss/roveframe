"""RoveAgent Enterprise Memory — 蓝图 Phase 6 的 L0–L4 分层租户隔离记忆。

构建在 fork 而来的 FTS5 会话搜索能力（``roveagent.state.search``）同一
技术栈之上：SQLite + FTS5 全文索引，零第三方依赖。

分层::

    L0  全局 AI 知识（所有租户可读）
    L1  行业知识（按 industry 隔离）
    L2  门店经营记忆（tenant_id + business_id）
    L3  客户记忆（tenant_id + business_id + customer_id）
    L4  会话记忆（tenant_id + business_id + session_id）

检索强制租户过滤：调用方无法跨租户读到 L2+ 数据。排序 = BM25 相关度
+ 时效衰减 + 重要度加权。支持过期策略（expires_at）。
"""
from __future__ import annotations

import re
import sqlite3
import time
import uuid
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path
from typing import Optional, Sequence


class MemoryLayer(IntEnum):
    L0_GLOBAL = 0
    L1_INDUSTRY = 1
    L2_TENANT = 2
    L3_CUSTOMER = 3
    L4_SESSION = 4


@dataclass
class MemoryRecord:
    id: str
    layer: MemoryLayer
    content: str
    tenant_id: str = ""
    business_id: str = ""
    industry: str = ""
    customer_id: str = ""
    session_id: str = ""
    kind: str = "fact"           # fact / decision / pattern / episode
    importance: float = 0.5      # 0..1
    created_at: float = 0.0
    expires_at: float = 0.0      # 0 = 永不过期
    score: float = 0.0           # 检索时填充


_SCHEMA = """
CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY,
    layer INTEGER NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT '',
    business_id TEXT NOT NULL DEFAULT '',
    industry TEXT NOT NULL DEFAULT '',
    customer_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5,
    created_at REAL NOT NULL,
    expires_at REAL NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    id UNINDEXED, content, tokenize = 'trigram'
);
"""

_RECENCY_HALFLIFE_DAYS = 30.0


class EnterpriseMemory:
    """单文件 SQLite 企业记忆库。每个部署一个实例（可放在 RoveAgent root）。"""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.db_path))
        self.db.executescript(_SCHEMA)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(memory)")}
        if "business_id" not in columns:
            self.db.execute(
                "ALTER TABLE memory ADD COLUMN business_id TEXT NOT NULL DEFAULT ''"
            )
        self.db.execute("DROP INDEX IF EXISTS idx_memory_tenant")
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_tenant_business "
            "ON memory(tenant_id, business_id, layer)"
        )
        self.db.execute(
            "CREATE INDEX IF NOT EXISTS idx_memory_expiry ON memory(expires_at)"
        )
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    def __enter__(self) -> "EnterpriseMemory":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    def add(
        self,
        content: str,
        layer: MemoryLayer,
        *,
        tenant_id: str = "",
        business_id: str = "",
        industry: str = "",
        customer_id: str = "",
        session_id: str = "",
        kind: str = "fact",
        importance: float = 0.5,
        ttl_days: float = 0.0,
    ) -> str:
        if layer >= MemoryLayer.L2_TENANT and (not tenant_id or not business_id):
            raise ValueError(
                "L2+ memory requires tenant_id and business_id "
                "(isolation invariant)"
            )
        now = time.time()
        expires = now + ttl_days * 86400 if ttl_days > 0 else 0.0
        rid = uuid.uuid4().hex
        self.db.execute(
            "INSERT INTO memory (id, layer, tenant_id, business_id, industry,"
            " customer_id, session_id, kind, content, importance, created_at,"
            " expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (rid, int(layer), tenant_id, business_id, industry, customer_id,
             session_id, kind, content, max(0.0, min(1.0, importance)), now,
             expires),
        )
        self.db.execute("INSERT INTO memory_fts (id, content) VALUES (?,?)",
                        (rid, content))
        self.db.commit()
        return rid

    # ------------------------------------------------------------------
    def search(
        self,
        query: str,
        *,
        tenant_id: str,
        business_id: str,
        industry: str = "",
        session_id: str = "",
        layers: Optional[Sequence[MemoryLayer]] = None,
        limit: int = 8,
    ) -> list[MemoryRecord]:
        """租户过滤检索。L0 全局 + L1 同行业 + L2/L3/L4 本租户。"""
        if not tenant_id or not business_id:
            raise ValueError("tenant_id and business_id are required")
        now = time.time()
        wanted = set(layers) if layers else {
            MemoryLayer.L0_GLOBAL, MemoryLayer.L1_INDUSTRY,
            MemoryLayer.L2_TENANT, MemoryLayer.L3_CUSTOMER, MemoryLayer.L4_SESSION,
        }

        layer_clauses: list[str] = []
        params: list[object] = []
        if MemoryLayer.L0_GLOBAL in wanted:
            layer_clauses.append("m.layer = 0")
        if MemoryLayer.L1_INDUSTRY in wanted and industry:
            layer_clauses.append("(m.layer = 1 AND m.industry = ?)")
            params.append(industry)
        tenant_layers = [int(l) for l in wanted if l >= MemoryLayer.L2_TENANT]
        if tenant_layers:
            ph = ",".join("?" * len(tenant_layers))
            layer_clauses.append(
                f"(m.layer IN ({ph}) AND m.tenant_id = ? AND m.business_id = ?)"
            )
            params.extend(tenant_layers)
            params.append(tenant_id)
            params.append(business_id)
        if not layer_clauses:
            return []

        where = " AND ".join([
            "(" + " OR ".join(layer_clauses) + ")",
            "(m.expires_at = 0 OR m.expires_at > ?)",
        ])
        params.append(now)

        q = query.strip()
        if q and self._fts_ready(q):
            # 每个检索词加引号成 phrase，避免用户输入中的特殊字符破坏 MATCH 语法
            match_q = " ".join('"' + t.replace('"', '""') + '"'
                               for t in re.split(r"\s+", q) if t)
            sql = (
                "SELECT m.*, bm25(memory_fts) AS rank FROM memory m"
                " JOIN memory_fts f ON f.id = m.id"
                f" WHERE memory_fts MATCH ? AND {where}"
                " ORDER BY rank LIMIT ?"
            )
            try:
                rows = self.db.execute(sql, [match_q, *params, limit * 4]).fetchall()
            except sqlite3.OperationalError:
                rows = self._like_search(q, where, params, limit)
        elif q:
            # trigram 分词要求 token ≥3 字符；短查询退化为 LIKE 子串扫描
            rows = self._like_search(q, where, params, limit)
        else:
            sql = (
                "SELECT m.*, 0.0 AS rank FROM memory m"
                f" WHERE {where} ORDER BY m.created_at DESC LIMIT ?"
            )
            rows = self.db.execute(sql, [*params, limit * 4]).fetchall()

        records = [self._row_to_record(r) for r in rows]
        for r in records:
            age_days = (now - r.created_at) / 86400.0
            recency = 0.5 ** (age_days / _RECENCY_HALFLIFE_DAYS)
            relevance = 1.0 / (1.0 + abs(r.score)) if query.strip() else 1.0
            r.score = round(0.55 * relevance + 0.25 * recency + 0.20 * r.importance, 6)
        records.sort(key=lambda r: r.score, reverse=True)
        return records[:limit]

    # ------------------------------------------------------------------
    def _like_search(self, q: str, where: str, params: list, limit: int) -> list:
        """LIKE 子串回退（短 token / MATCH 语法异常时）。多词按 AND 过滤。"""
        tokens = [t for t in re.split(r"\s+", q) if t]
        cond = " AND ".join("m.content LIKE ? ESCAPE '\\'" for _ in tokens)
        likes = ["%" + t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                 for t in tokens]
        sql = (
            "SELECT m.*, 0.0 AS rank FROM memory m"
            f" WHERE {cond} AND {where}"
            " ORDER BY m.importance DESC, m.created_at DESC LIMIT ?"
        )
        return self.db.execute(sql, [*likes, *params, limit * 4]).fetchall()

    @staticmethod
    def _fts_ready(query: str) -> bool:
        """trigram 分词要求每个检索词 ≥3 字符，否则走 LIKE 回退。"""
        tokens = [t for t in re.split(r"\s+", query) if t]
        return bool(tokens) and all(len(t) >= 3 for t in tokens)

    def purge_expired(self) -> int:
        now = time.time()
        ids = [r[0] for r in self.db.execute(
            "SELECT id FROM memory WHERE expires_at > 0 AND expires_at <= ?",
            (now,)).fetchall()]
        for rid in ids:
            self.db.execute("DELETE FROM memory WHERE id = ?", (rid,))
            self.db.execute("DELETE FROM memory_fts WHERE id = ?", (rid,))
        self.db.commit()
        return len(ids)

    def count(self, tenant_id: Optional[str] = None,
              business_id: Optional[str] = None) -> int:
        if tenant_id is None:
            return self.db.execute("SELECT COUNT(*) FROM memory").fetchone()[0]
        if not business_id:
            raise ValueError("business_id is required with tenant_id")
        return self.db.execute(
            "SELECT COUNT(*) FROM memory WHERE "
            "(tenant_id = ? AND business_id = ?) OR layer < 2",
            (tenant_id, business_id)).fetchone()[0]

    # ------------------------------------------------------------------
    @staticmethod
    def _row_to_record(row: tuple) -> MemoryRecord:
        (rid, layer, tenant_id, business_id, industry, customer_id, session_id, kind,
         content, importance, created_at, expires_at, rank) = row
        return MemoryRecord(
            id=rid, layer=MemoryLayer(layer), content=content,
            tenant_id=tenant_id, business_id=business_id, industry=industry,
            customer_id=customer_id,
            session_id=session_id, kind=kind, importance=importance,
            created_at=created_at, expires_at=expires_at, score=float(rank),
        )
