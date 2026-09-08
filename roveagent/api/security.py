"""P0-10：服务层输入白名单净化。

RoveFrame 的 tenant_id / business_id / skill 名会参与磁盘路径拼接
（``skills/tenant-<id>/<skill>`` 等），必须统一白名单校验：
仅允许 ``[A-Za-z0-9_-]``（1..64 字符）。非法输入 fail-closed 拒绝，
禁止静默重写导致租户名碰撞（如 ``A/B`` 与 ``AB`` 落同一目录）。
"""
from __future__ import annotations

import re

_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SKILL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def require_safe_id(value: str, *, label: str = "identifier") -> str:
    """校验并返回原值；非法（含路径穿越字符）抛 ValueError（调用方转 422）。"""
    if not isinstance(value, str) or not _ID_PATTERN.fullmatch(value):
        raise ValueError(
            f"invalid {label}: only [A-Za-z0-9_-] (1-64 chars) allowed")
    return value


def sanitize_skill_name(value: str) -> str:
    """技能名净化：去非法字符 + 小写 + 截断；结果为空抛 ValueError。"""
    cleaned = "".join(c for c in value if c.isalnum() or c in "-_").lower()[:64]
    if not cleaned:
        raise ValueError("invalid skill name: empty after sanitization")
    return cleaned
