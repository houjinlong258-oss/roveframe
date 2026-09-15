"""R13 扫描：可选依赖守卫里的「except Exception + fail-closed」反模式。

背景（Phase 2b 发现）
--------------------
``model_tools.py`` 的 ACP 编辑审批守卫把**外部可选模块未安装**
（``ModuleNotFoundError``）当成「守卫失败」，于是 fail-closed 拒绝，
导致所有 ``write_file`` / ``patch`` 在全仓层面失效。

这是一个**系统性反模式**，本脚本做静态扫描，找出同类可疑点：

    try:
        from <可选模块> import ...
        ...守卫逻辑...
    except Exception:
        ...deny / fail-closed / return error...

输出按可疑度排序。只读。
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path
from typing import Iterator

REPO = Path(__file__).resolve().parent.parent
ROOTS = [REPO / "roveagent"]

#: 出现这些词说明 except 分支是「拒绝/失败」语义
DENY_MARKERS = (
    "deny", "denied", "block", "blocked", "forbid", "forbidden",
    "fail_closed", "fail-closed", "return error", "tool_error",
    "reject", "rejected", "not allowed", "refus", "unauthori",
)
#: 出现这些词说明这是「可选/外部」依赖
OPTIONAL_MARKERS = (
    "acp", "plugin", "optional", "if available", "may not",
    "not installed", "third", "vendor",
)


def _iter_try_nodes(tree: ast.AST) -> Iterator[ast.Try]:
    for node in ast.walk(tree):
        if isinstance(node, ast.Try):
            yield node


def _segment(source: str, node: ast.AST) -> str:
    try:
        return ast.get_source_segment(source, node) or ""
    except Exception:  # noqa: BLE001
        return ""


def _has_bare_exception(handlers: list[ast.ExceptHandler]) -> bool:
    for handler in handlers:
        if handler.type is None:
            return True
        seg = _segment("", handler.type)
        if isinstance(handler.type, ast.Name) and handler.type.id == "Exception":
            return True
    return False


def _imports_inside(node: ast.Try) -> list[str]:
    """try body 里的 import 目标（用于判断是否在导入可选模块）。"""
    names: list[str] = []
    for child in ast.walk(node):
        if isinstance(child, ast.ImportFrom) and child.module:
            names.append(child.module)
        elif isinstance(child, ast.Import):
            for alias in child.names:
                names.append(alias.name)
    return names


def main() -> int:
    candidates: list[tuple[int, str, int, str]] = []
    scanned = 0

    for root in ROOTS:
        for path in root.rglob("*.py"):
            if "__pycache__" in path.parts:
                continue
            if path.name.endswith("_test.py") or path.name.startswith("test_"):
                continue
            try:
                source = path.read_text(encoding="utf-8")
            except Exception:  # noqa: BLE001
                continue
            scanned += 1
            try:
                tree = ast.parse(source)
            except SyntaxError:
                continue

            lines = source.splitlines()
            for node in _iter_try_nodes(tree):
                if not _has_bare_exception(node.handlers):
                    continue
                imported = _imports_inside(node)
                if not imported:
                    continue
                handler_src = "\n".join(
                    _segment(source, h) for h in node.handlers
                ).lower()
                if not any(m in handler_src for m in DENY_MARKERS):
                    continue

                # 计算可疑度
                score = 0
                module_blob = " ".join(imported).lower()
                if any(m in module_blob for m in OPTIONAL_MARKERS):
                    score += 2
                # 只 import 顶层包名（无 from-import 具体符号）更容易出问题
                if all("." not in name for name in imported):
                    score += 1
                # handler 直接 return 一个"拒绝"结果
                if "return" in handler_src:
                    score += 1
                # 没有 logger.debug/info 提示模块不存在
                if "modulenotfound" not in handler_src and "importerror" not in handler_src:
                    score += 1

                first_line = imported[0]
                candidates.append((score, str(path.relative_to(REPO)), node.lineno, first_line))

    candidates.sort(key=lambda c: (-c[0], c[1]))
    print(f"scanned {scanned} files; {len(candidates)} suspicious try/except blocks\n")
    print(f"{'score':5s} {'file':52s} {'line':6s} import")
    for score, rel, lineno, imp in candidates[:40]:
        print(f"{score:<5d} {rel:52s} {lineno:<6d} {imp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
