"""Create an allowlisted RoveFrame source archive outside the repository."""

from __future__ import annotations

import argparse
import subprocess
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIRS = (
    ".github",
    "docs",
    "messages",
    "packages",
    "public",
    "roveagent",
    "scripts",
    "src",
    "tests",
)
SOURCE_FILES = (
    ".dockerignore",
    ".env.example",
    ".gitignore",
    ".npmignore",
    ".npmrc",
    "AGENTS.md",
    "README.md",
    "components.json",
    "eslint.config.mjs",
    "next.config.ts",
    "package.json",
    "pnpm-lock.yaml",
    "postcss.config.mjs",
    "stylelint.config.mjs",
    "tsconfig.json",
)
BLOCKED_PARTS = {
    ".cache",
    ".git",
    ".next",
    ".pnpm-store",
    ".roveagent",
    ".worktrees",
    "__pycache__",
    "coverage",
    "dist",
    "node_modules",
    "tmp",
}
# 只在仓库根目录被排除的条目。必须与 BLOCKED_PARTS 分开：
# `artifacts/` 是根目录的构建产物，但 `src/lib/artifacts/`、`src/app/api/artifacts/`
# 是真实源码 —— 曾经因为按任意层级匹配，整块源码被静默排除，打出的包编译不过。
BLOCKED_ROOT_PARTS = {"artifacts"}
BLOCKED_SUFFIXES = (".log", ".pyc", ".pyo", ".tar", ".tar.gz", ".tgz", ".zip")


def is_allowed(path: Path) -> bool:
    relative_path = path.relative_to(ROOT)
    if relative_path.parts and relative_path.parts[0] in BLOCKED_ROOT_PARTS:
        return False
    if any(part in BLOCKED_PARTS for part in relative_path.parts):
        return False
    if path.name.startswith(".env") and path.name != ".env.example":
        return False
    return not path.name.lower().endswith(BLOCKED_SUFFIXES)


def source_files() -> list[Path]:
    files = [ROOT / name for name in SOURCE_FILES if (ROOT / name).is_file()]
    for directory in SOURCE_DIRS:
        base = ROOT / directory
        if base.is_dir():
            files.extend(path for path in base.rglob("*") if path.is_file() and is_allowed(path))
    return sorted(set(files))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    try:
        output.relative_to(ROOT)
    except ValueError:
        pass
    else:
        raise SystemExit("Source archives must be written outside the repository")

    subprocess.run(
        ["node", str(ROOT / "scripts" / "production-scan.mjs"), "all"],
        cwd=ROOT,
        check=True,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    files = source_files()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            archive.write(path, (Path("roveframe-ai-business-os") / path.relative_to(ROOT)).as_posix())
    print(f"Created source archive with {len(files)} files at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
