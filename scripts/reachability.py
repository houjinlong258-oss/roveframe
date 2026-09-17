#!/usr/bin/env python
"""真实可达性分析（Phase 13，只读）。

## 为什么需要它

审计报告的死代码清单用的是「**模块级**导入文本扫描」。该判据会漏掉
`roveagent/gateway/` 这类通过**函数级惰性导入**被大量使用的模块 ——
实测有 33 个顶层名字从外部导入它。按那份清单删除会打断 Agent 构造、
上下文压缩与定时任务。

本脚本改用真正的可达性分析：

  1. AST 解析 `roveagent/**/*.py`，收集**任意嵌套层级**的导入
     （`ast.walk` 覆盖函数体内部的 import）；
  2. 解析相对导入（`from .foo import bar`）为绝对模块名；
  3. 从**生产入口**出发做 BFS；
  4. 未被访问到的模块 = 候选死代码。

## 保守原则

**宁可高估可达，不可低估。** 每条边都按最宽的候选集展开（例如
`from . import x` 同时算作指向包本身与子模块 `x`）。多算一条边只会让
某个模块被判为"可达"从而**不**被删；少算一条边会导致误删。两种错误的
代价不对称，因此这里刻意偏向保守。

测试文件**不作为入口**（它们导入被测模块，那不能证明该模块有生产用途），
但会被单独标注：只被测试引用的模块是"有测试的死代码"，与"完全无人引用"
是两种不同的处置对象。

## 用法

    python scripts/reachability.py                 # 摘要
    python scripts/reachability.py --list          # 列出全部不可达模块
    python scripts/reachability.py --json out.json # 机器可读
"""
from __future__ import annotations

import argparse
import ast
import json
import sys
from collections import deque
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PKG_ROOT = REPO_ROOT / "roveagent"

#: 生产入口。每个都必须能回答"谁在什么场景下启动它"。
ENTRY_POINTS = (
    "roveagent.api.app",       # FastAPI 运行时（uvicorn roveagent.api.app:get_app）
    "roveagent.clisupport.main",  # CLI 入口（pyproject [project.scripts]）
    "roveagent.cron.scheduler",   # 定时任务
    "roveagent.gateway.run",      # 独立网关（python -m roveagent.gateway.run）
    "roveagent.kernel",           # 内核（api/app.py 直接构造）
    "roveagent.runtime",          # AIAgent（api/app.py 延迟导入）
    "roveagent.bootstrap",        # 启动装配
    "roveagent.model_tools",      # 工具定义
    "roveagent.toolsets",         # 工具集
    "roveagent.tools.registry",   # 工具注册表
    "roveagent.clisupport.container_boot",  # 容器启动路径
)


def module_name_for(path: Path) -> str:
    rel = path.relative_to(REPO_ROOT).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "__init__":
        parts.pop()
    return ".".join(parts)


def package_for(path: Path, module: str) -> str:
    """该模块的相对导入基准包。"""
    if path.name == "__init__.py":
        return module
    return module.rsplit(".", 1)[0] if "." in module else ""


def resolve_candidates(node: ast.AST, package: str) -> set[str]:
    """把一个 import 语句展开成**最宽**的候选绝对模块名集合。"""
    out: set[str] = set()

    if isinstance(node, ast.Import):
        for alias in node.names:
            out.add(alias.name)
            out.add(f"{alias.name}.{alias.name.rsplit('.', 1)[-1]}")  # 少见但无害
        return out

    if isinstance(node, ast.ImportFrom):
        base = node.module or ""
        if node.level:
            # 相对导入：level=1 指当前包
            up = package
            for _ in range(node.level - 1):
                up = up.rsplit(".", 1)[0] if "." in up else ""
            base = f"{up}.{base}" if up and base else (up or base)
        if base:
            out.add(base)
        for alias in node.names:
            if alias.name == "*":
                continue
            # `from pkg import name` 中 name 既可能是子模块也可能是属性。
            # 两种都算，避免漏边。
            if base:
                out.add(f"{base}.{alias.name}")
            else:
                out.add(alias.name)
        return out

    return out


def build_graph() -> tuple[dict[str, set[str]], dict[str, int], dict[str, Path]]:
    graph: dict[str, set[str]] = {}
    lines: dict[str, int] = {}
    paths: dict[str, Path] = {}

    for path in sorted(PKG_ROOT.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        module = module_name_for(path)
        paths[module] = path
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
            tree = ast.parse(source)
        except SyntaxError as exc:
            print(f"WARN: cannot parse {path}: {exc}", file=sys.stderr)
            graph[module] = set()
            lines[module] = len(source.splitlines())
            continue

        lines[module] = len(source.splitlines())
        package = package_for(path, module)
        edges: set[str] = set()
        # ast.walk 覆盖函数体内、类体内、条件分支内的 import。
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                edges |= resolve_candidates(node, package)
        graph[module] = edges

    return graph, lines, paths


def reachable_from(entries: tuple[str, ...], graph: dict[str, set[str]]) -> set[str]:
    seen: set[str] = set()
    queue: deque[str] = deque(entries)
    while queue:
        current = queue.popleft()
        if current in seen:
            continue
        seen.add(current)
        for nxt in graph.get(current, ()):  # 只沿包内边展开
            if nxt.startswith("roveagent") and nxt not in seen:
                queue.append(nxt)
    return seen


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="RoveFrame reachability analysis (read-only)")
    parser.add_argument("--list", action="store_true", help="列出全部不可达模块")
    parser.add_argument("--json", default="", help="写出机器可读结果")
    args = parser.parse_args(argv)

    graph, lines, paths = build_graph()
    print(f"扫描模块: {len(graph)}")

    reachable = reachable_from(ENTRY_POINTS, graph)
    reachable_in_pkg = {m for m in reachable if m in graph}
    print(f"生产入口可达: {len(reachable_in_pkg)}")

    unreachable = sorted(set(graph) - reachable_in_pkg)

    # 只被测试引用的模块：有测试但与生产无关，单独归类。
    test_modules = {m for m in graph if m.rsplit(".", 1)[-1].endswith("_test") or ".tests." in m}
    referenced_by_tests: set[str] = set()
    for m in test_modules:
        for nxt in graph.get(m, ()):
            if nxt in graph and nxt not in reachable_in_pkg:
                referenced_by_tests.add(nxt)

    only_tests = sorted(set(unreachable) & referenced_by_tests)
    nobody = sorted(set(unreachable) - referenced_by_tests)

    print(f"不可达: {len(unreachable)}")
    print(f"  其中仅被测试引用: {len(only_tests)}")
    print(f"  完全无人引用:     {len(nobody)}")

    unreachable_lines = sum(lines.get(m, 0) for m in unreachable)
    print(f"不可达行数: {unreachable_lines}")

    # 按顶层包分组，给出可删除的粒度。
    groups: dict[str, dict[str, int]] = {}
    for m in unreachable:
        top = ".".join(m.split(".")[:2])
        g = groups.setdefault(top, {"modules": 0, "lines": 0})
        g["modules"] += 1
        g["lines"] += lines.get(m, 0)
    print("\n按顶层包分组（不可达）:")
    for top, g in sorted(groups.items(), key=lambda kv: -kv[1]["lines"])[:25]:
        print(f"  {top:<38} {g['modules']:>4} 模块 {g['lines']:>7} 行")

    if args.list:
        print("\n== 完全无人引用 ==")
        for m in nobody:
            print(f"  {lines.get(m, 0):>6} 行  {m}")
        print("\n== 仅被测试引用 ==")
        for m in only_tests:
            print(f"  {lines.get(m, 0):>6} 行  {m}")

    if args.json:
        out = {
            "scanned": len(graph),
            "entry_points": list(ENTRY_POINTS),
            "reachable": sorted(reachable_in_pkg),
            "unreachable": unreachable,
            "only_referenced_by_tests": only_tests,
            "unreferenced": nobody,
            "unreachable_lines": unreachable_lines,
        }
        Path(args.json).write_text(json.dumps(out, indent=2), encoding="utf-8")
        print(f"\nJSON 写入 {args.json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
