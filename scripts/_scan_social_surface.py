"""Phase 6 scan — social automation surface (read-only).

The `social` toolset exists but its own description states there is no
bundled publish tool. Phase 6 needs to know exactly what is present before
deciding what to build, so this inventories:

  1. the `social` toolset declaration + any social-ish registered tool
  2. per-platform support the runtime already has (publishers, auth, upload)
  3. the TS-side channel/publish surface the app already exposes
  4. which of the six target platforms are absent entirely

Read-only. No writes, no network.

Run:  python scripts/_scan_social_surface.py
"""
from __future__ import annotations

import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PLATFORMS = [
    "linkedin", "tiktok", "youtube", "bilibili",
    "xiaohongshu", "rednote", "instagram", "facebook",
    "twitter", "x_twitter", "weibo", "douyin", "threads",
]

NAME_PAT = re.compile(
    r"""registry\.register\(\s*(?:[^)]*?)name\s*=\s*["']([A-Za-z_0-9]+)["']""",
    re.S,
)

SOCIAL_HINTS = (
    "social", "publish", "post_", "tweet", "upload_video", "schedule_post",
    "trend", "hashtag", "campaign", "content_",
)


def hdr(t: str) -> None:
    print()
    print("=" * 78)
    print(t)
    print("=" * 78)


def main() -> int:
    rroot = os.path.join(ROOT, "roveagent")

    hdr("[1] social-ish registered tools")
    found: dict[str, set[str]] = {}
    for dirpath, dirnames, filenames in os.walk(rroot):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            path = os.path.join(dirpath, fn)
            try:
                src = open(path, encoding="utf-8", errors="replace").read()
            except OSError:
                continue
            for m in NAME_PAT.finditer(src):
                nm = m.group(1)
                if any(h in nm for h in SOCIAL_HINTS):
                    found.setdefault(nm, set()).add(os.path.relpath(path, rroot))
    if found:
        for nm in sorted(found):
            print("  %-30s %s" % (nm, ", ".join(sorted(found[nm]))[:70]))
    else:
        print("  (none)")

    hdr("[2] per-platform presence in the python tree")
    hits_by_platform: dict[str, list[str]] = {}
    for dirpath, dirnames, filenames in os.walk(rroot):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in filenames:
            low = fn.lower()
            for p in PLATFORMS:
                if p in low:
                    hits_by_platform.setdefault(p, []).append(
                        os.path.relpath(os.path.join(dirpath, fn), rroot))
    for p in PLATFORMS:
        files = sorted(set(hits_by_platform.get(p, [])))
        mark = "PRESENT" if files else "ABSENT "
        print("  %-14s %s  %s" % (p, mark, ", ".join(files[:3])[:70]))

    hdr("[3] the social toolset declaration")
    from roveagent.toolsets import TOOLSETS

    social = TOOLSETS.get("social")
    if social is None:
        print("  'social' toolset MISSING")
    else:
        print("  description:", str(social.get("description", ""))[:300])
        print("  tools      :", social.get("tools"))
        print("  includes   :", social.get("includes"))

    hdr("[4] TS channel / publish surface")
    base = os.path.join(ROOT, "src", "app", "api")
    for dirpath, _d, filenames in os.walk(base):
        for fn in filenames:
            rel = os.path.relpath(os.path.join(dirpath, fn), base).replace(os.sep, "/")
            if any(k in rel.lower() for k in ("channel", "social", "publish", "marketing", "content")):
                print("  /api/" + rel[: -len("/route.ts")])

    hdr("[5] TS marketing/channel files on disk")
    for sub in ("src/lib", "src/components"):
        for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, sub)):
            dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".next")]
            for fn in filenames:
                if any(k in fn.lower() for k in ("social", "channel", "publish")):
                    p = os.path.join(dirpath, fn)
                    print("  %-64s %6d" % (os.path.relpath(p, ROOT), os.path.getsize(p)))

    hdr("[6] gap summary")
    present = [p for p in PLATFORMS if hits_by_platform.get(p)]
    absent = [p for p in PLATFORMS if not hits_by_platform.get(p)]
    print("  platforms with python-side files : %s" % (", ".join(present) or "none"))
    print("  platforms with no python files   : %s" % (", ".join(absent) or "none"))
    print("  social toolset tools declared    : %s" % (social.get("tools") if social else "n/a"))
    print()
    print("[done] read-only; no files written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
