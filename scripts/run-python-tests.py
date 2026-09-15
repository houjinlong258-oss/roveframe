#!/usr/bin/env python
"""Python 测试运行器 —— 默认强制离线（Phase 10 / Task 5）。

为什么需要这个脚本而不是直接 `python -m unittest`：

实测 `python -m unittest discover -s roveagent` 会触发
`Auxiliary client: PAID lane engaged … may incur real spend`，即**测试进程会向
OpenRouter / Nous 发起真实的付费请求**。测试环境保护不能依赖「本机恰好没有
凭据」—— 仓库中的 `.env` 与 `scripts/deploy.env` 就提供了真实值。

因此 `package.json` 的 `test:python` 改为调用本脚本，由它设置
`ROVEAGENT_OFFLINE=1`（见 `roveagent/core/auxiliary_client.py::_offline_guard_active`），
保证 CI 与本地测试**零外部消费**。

需要真实联调时显式覆盖：`ROVEAGENT_OFFLINE=0 python scripts/run-python-tests.py`

不引入任何第三方依赖；跨平台（不使用 shell 语法）。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def main(argv: list[str]) -> int:
    # 默认离线；显式设置 ROVEAGENT_OFFLINE=0 才放行真实外部调用。
    offline = os.environ.get("ROVEAGENT_OFFLINE", "1").strip()
    os.environ["ROVEAGENT_OFFLINE"] = offline or "1"
    effective = os.environ["ROVEAGENT_OFFLINE"].lower() in ("1", "true", "yes")

    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))

    print(
        f"[run-python-tests] ROVEAGENT_OFFLINE={os.environ['ROVEAGENT_OFFLINE']} "
        f"({'no external provider calls' if effective else 'REAL PROVIDER CALLS ALLOWED'})"
    )

    loader = unittest.TestLoader()
    suite = loader.discover(
        start_dir=str(REPO_ROOT / "roveagent"),
        top_level_dir=str(REPO_ROOT),
        pattern="*_test.py",
    )
    runner = unittest.TextTestRunner(verbosity=1, buffer=False)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
